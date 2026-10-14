import pathlib,subprocess,urllib.request,json,hashlib,tarfile,os
import platform
if os.geteuid()!=0:raise SystemExit('Run with sudo on Ubuntu 24.04 x86_64')
if platform.machine() not in ('x86_64','amd64'):raise SystemExit('This installer requires x86_64 Google Chrome')
base=pathlib.Path('/opt/webshot');base.mkdir(exist_ok=True)
with urllib.request.urlopen('https://nodejs.org/dist/index.json',timeout=30) as r:releases=json.load(r)
release=next(x for x in releases if x['version'].startswith('v24.') and x.get('lts'))['version']
archive='node-'+release+'-linux-x64.tar.xz'
root='https://nodejs.org/dist/'+release+'/'
with urllib.request.urlopen(root+'SHASUMS256.txt',timeout=30) as r:sums=r.read().decode()
expected=next(line.split()[0] for line in sums.splitlines() if line.split()[-1]==archive)
target=pathlib.Path('/var/tmp')/archive
urllib.request.urlretrieve(root+archive,target)
assert hashlib.sha256(target.read_bytes()).hexdigest()==expected
with tarfile.open(target) as t:t.extractall(base,filter='data')
p=base/'node'
if not p.exists():p.symlink_to(base/('node-'+release+'-linux-x64'))
target.unlink()
print('node_installed',release,flush=True)
deb=pathlib.Path('/var/tmp/google-chrome-stable_current_amd64.deb')
urllib.request.urlretrieve('https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb',deb)
print('chrome_vendor_package_downloaded',deb.stat().st_size,flush=True)
subprocess.run(['apt-get','update','-qq'],check=True)
subprocess.run(['env','DEBIAN_FRONTEND=noninteractive','apt-get','install','-y','--no-install-recommends',str(deb),'nginx','certbot','fonts-noto-cjk','fonts-noto-color-emoji'],check=True)
deb.unlink()
print(subprocess.run(['/usr/bin/google-chrome-stable','--version'],capture_output=True,text=True).stdout)
print(subprocess.run([str(base/'node/bin/node'),'--version'],capture_output=True,text=True).stdout)
