import argparse,os,re
parser=argparse.ArgumentParser(description='使用已经签发的证书启用 Webshot HTTPS')
parser.add_argument('--domain',required=True)
args=parser.parse_args()
if os.geteuid()!=0:raise SystemExit('请使用 sudo 执行')
if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?',args.domain):raise SystemExit('域名无效')
from pathlib import Path
import subprocess
if not Path('/etc/letsencrypt/live/webshot/fullchain.pem').is_file():raise SystemExit('先签发 webshot 证书')
Path('/etc/nginx/sites-available/webshot').write_text('''server {
  listen 80;
  server_name __DOMAIN__;
  access_log off;
  location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
  location / { return 301 https://$host$request_uri; }
}
server {
  listen 443 ssl;
  http2 on;
  server_name __DOMAIN__;
  ssl_certificate /etc/letsencrypt/live/webshot/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/webshot/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:WebshotSSL:2m;
  ssl_session_timeout 1d;
  access_log off;
  error_log /var/log/nginx/webshot-error.log crit;
  gzip on;
  gzip_types text/css application/javascript text/javascript application/json;
  client_max_body_size 1m;
  location /healthz { allow 127.0.0.1; deny all; include snippets/webshot-proxy.conf; }
  location / { include snippets/webshot-proxy.conf; }
}
'''.replace('__DOMAIN__',args.domain).replace('listen 443 ssl;\n  http2 on;','listen 443 ssl http2;'))
hook=Path('/etc/letsencrypt/renewal-hooks/deploy/reload-webshot-nginx');hook.parent.mkdir(parents=True,exist_ok=True)
hook.write_text('#!/bin/sh\n/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx\n');hook.chmod(0o755)
subprocess.run(['nginx','-t'],check=True)
subprocess.run(['systemctl','reload','nginx'],check=True)
subprocess.run(['systemctl','enable','--now','certbot.timer'],check=True)
