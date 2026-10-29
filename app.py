import os,sqlite3,csv,io,secrets
from pathlib import Path
from functools import wraps
from flask import Flask,request,jsonify,render_template,session,redirect,Response,send_from_directory
from werkzeug.utils import secure_filename
from werkzeug.security import check_password_hash
from openpyxl import load_workbook

BASE=Path(__file__).resolve().parent
DATA=Path(os.environ.get('DATA_DIR',str(BASE/'data')))
DATA.mkdir(parents=True,exist_ok=True)
UPLOAD=DATA/'uploads';UPLOAD.mkdir(exist_ok=True)
app=Flask(__name__);app.secret_key=os.environ.get('SECRET_KEY',secrets.token_hex(32));app.config['MAX_CONTENT_LENGTH']=12*1024*1024
DB=DATA/'salons.sqlite3'
FIELDS=['name','area','phone','reviews','followers','candidate','outreach','maps','notes','status','visit','profile','paid','print','resp','by_user']

def connect():
 c=sqlite3.connect(DB);c.row_factory=sqlite3.Row;return c

def init():
 with connect() as c:
  c.execute('''CREATE TABLE IF NOT EXISTS salons (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,area TEXT DEFAULT '',phone TEXT DEFAULT '',reviews INTEGER,followers INTEGER,candidate TEXT DEFAULT '',outreach TEXT DEFAULT 'Not contacted',maps TEXT DEFAULT '',notes TEXT DEFAULT '',status TEXT DEFAULT 'New',visit INTEGER DEFAULT 0,profile INTEGER DEFAULT 0,paid INTEGER DEFAULT 0,print INTEGER DEFAULT 0,resp INTEGER DEFAULT 0,by_user TEXT DEFAULT 'Admin',updated_at TEXT DEFAULT CURRENT_TIMESTAMP)''')
  c.execute('''CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY AUTOINCREMENT,salon_id INTEGER NOT NULL,filename TEXT NOT NULL,FOREIGN KEY(salon_id) REFERENCES salons(id))''')
init()

def auth(f):
 @wraps(f)
 def wrapped(*a,**kw):
  if not session.get('ok'):return jsonify(error='Login required'),401
  return f(*a,**kw)
 return wrapped

@app.get('/')
def home():return render_template('index.html')
@app.get('/health')
def health():return {'ok':True}
@app.get('/api/me')
def me():return {'authenticated':bool(session.get('ok')),'configured':bool(os.environ.get('ADMIN_PASSWORD'))}
@app.post('/api/login')
def login():
 pwd=os.environ.get('ADMIN_PASSWORD','')
 if not pwd:return jsonify(error='Set ADMIN_PASSWORD in Railway environment variables'),503
 submitted=(request.get_json(silent=True) or {}).get('password','')
 if not secrets.compare_digest(str(submitted),pwd):return jsonify(error='Incorrect password'),403
 session.clear();session['ok']=True;return {'ok':True}
@app.post('/api/logout')
def logout():session.clear();return {'ok':True}

def get_all(c):
 rows=[dict(x) for x in c.execute('SELECT * FROM salons ORDER BY id DESC')]
 photos={}
 for p in c.execute('SELECT * FROM photos'):
  photos.setdefault(p['salon_id'],[]).append({'id':p['id'],'url':'/api/photos/'+str(p['id'])})
 for r in rows:r['photos']=photos.get(r['id'],[])
 return rows
@app.get('/api/salons')
@auth
def salons():
 with connect() as c:return jsonify(get_all(c))

def clean(data,existing=None):
 out={}
 for f in FIELDS:
  if f not in data:continue
  v=data[f]
  if f in ('visit','profile','paid','print'):v=int(bool(v))
  elif f in ('reviews','followers'):v=None if v in ('',None) else max(0,int(v))
  elif f=='resp':v=max(-5,min(5,int(v or 0)))
  else:v=str(v or '').strip()[:5000]
  out[f]=v
 if 'name' in out and not out['name']:raise ValueError('Salon name is required')
 return out
@app.post('/api/salons')
@auth
def create():
 try:d=clean(request.get_json(force=True));assert d.get('name')
 except (ValueError,TypeError,AssertionError):return jsonify(error='Valid salon name and numbers required'),400
 with connect() as c:
  keys=list(d);cur=c.execute(f"INSERT INTO salons ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})",list(d.values()))
  return jsonify(id=cur.lastrowid),201
@app.patch('/api/salons/<int:sid>')
@auth
def update(sid):
 try:d=clean(request.get_json(force=True))
 except (ValueError,TypeError):return jsonify(error='Invalid fields'),400
 if not d:return jsonify(error='No changes'),400
 with connect() as c:
  result=c.execute('UPDATE salons SET '+','.join(f'{k}=?' for k in d)+',updated_at=CURRENT_TIMESTAMP WHERE id=?',[*d.values(),sid])
  if not result.rowcount:return jsonify(error='Not found'),404
 return {'ok':True}
@app.delete('/api/salons/<int:sid>')
@auth
def delete(sid):
 with connect() as c:
  for p in c.execute('SELECT filename FROM photos WHERE salon_id=?',(sid,)):
   (UPLOAD/p['filename']).unlink(missing_ok=True)
  c.execute('DELETE FROM photos WHERE salon_id=?',(sid,));c.execute('DELETE FROM salons WHERE id=?',(sid,))
 return {'ok':True}
@app.post('/api/salons/<int:sid>/photos')
@auth
def photo_upload(sid):
 f=request.files.get('photo')
 if not f or not f.mimetype.startswith('image/') or f.mimetype not in ('image/jpeg','image/png','image/webp','image/gif'):return jsonify(error='JPEG, PNG, WEBP or GIF required'),400
 with connect() as c:
  if not c.execute('SELECT id FROM salons WHERE id=?',(sid,)).fetchone():return jsonify(error='Not found'),404
  ext={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif'}[f.mimetype]
  filename=secrets.token_hex(16)+ext;f.save(UPLOAD/filename)
  p=c.execute('INSERT INTO photos(salon_id,filename) VALUES(?,?)',(sid,filename))
  return jsonify(id=p.lastrowid,url='/api/photos/'+str(p.lastrowid)),201
@app.get('/api/photos/<int:pid>')
@auth
def photo(pid):
 with connect() as c:p=c.execute('SELECT filename FROM photos WHERE id=?',(pid,)).fetchone()
 if not p:return jsonify(error='Not found'),404
 return send_from_directory(UPLOAD,p['filename'])
@app.delete('/api/photos/<int:pid>')
@auth
def remove_photo(pid):
 with connect() as c:
  p=c.execute('SELECT filename FROM photos WHERE id=?',(pid,)).fetchone()
  if p:(UPLOAD/p['filename']).unlink(missing_ok=True);c.execute('DELETE FROM photos WHERE id=?',(pid,))
 return {'ok':True}
@app.get('/api/export')
@auth
def export():
 with connect() as c:rows=get_all(c)
 s=io.StringIO();cols=['id']+FIELDS+['updated_at'];w=csv.DictWriter(s,fieldnames=cols,extrasaction='ignore');w.writeheader();w.writerows(rows)
 return Response('\ufeff'+s.getvalue(),mimetype='text/csv',headers={'Content-Disposition':'attachment; filename=salon-tracker-export.csv'})
@app.post('/api/import')
@auth
def import_sheet():
 f=request.files.get('file')
 if not f:return jsonify(error='Choose an .xlsx file'),400
 try:
  wb=load_workbook(f,read_only=True,data_only=True);ws=wb.active
  it=ws.values;headers=[str(x or '').strip().lower() for x in next(it)]
  names={'salon':'name','area':'area','google reviews (reported)':'reviews','phone':'phone','review-based candidate':'candidate','instagram followers':'followers','outreach status':'outreach','google maps search':'maps','notes':'notes'}
  count=0;skipped=0
  with connect() as c:
   for row in it:
    d={names[h]:v for h,v in zip(headers,row) if h in names and v is not None}
    if not d.get('name'):continue
    try:d=clean(d)
    except (ValueError,TypeError):skipped+=1;continue
    # Deduplicate by normalized salon name + area
    exists=c.execute('SELECT id FROM salons WHERE lower(name)=lower(?) AND lower(area)=lower(?)',(d['name'],d.get('area',''))).fetchone()
    if exists:skipped+=1;continue
    keys=list(d);c.execute(f"INSERT INTO salons ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})",list(d.values()));count+=1
  return jsonify(imported=count,skipped=skipped)
 except Exception:return jsonify(error='Could not read Excel file; use a valid .xlsx workbook'),400
if __name__=='__main__':app.run(host='0.0.0.0',port=int(os.environ.get('PORT',8080)))
