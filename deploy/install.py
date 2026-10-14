#!/usr/bin/env python3
"""Install on Ubuntu x86_64. Existing environment and HTTPS vhost are preserved."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import urllib.request

REPO = Path(__file__).resolve().parents[1]
TEMPLATES = REPO / 'deploy/templates'

def write(path, content, mode=0o644):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    p.chmod(mode)

def merged_environment(existing, domain):
    lines = existing.splitlines()
    keys = {line.split('=', 1)[0] for line in lines if '=' in line and not line.startswith('#')}
    defaults = dict(NODE_ENV='production', PORT='3030', DB_PATH='/var/lib/webshot/requests.sqlite',
                    CHROME_PATH='/usr/bin/google-chrome-stable', PUBLIC_HOST=domain, WARM_PAGES='5', MAX_PAGES='7')
    return '\n'.join(lines + [f'{key}={value}' for key, value in defaults.items() if key not in keys]) + '\n'

def run(*args):
    subprocess.run(args, check=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--domain', required=True)
    parser.add_argument('--server-ip', action='append', required=True, help='Server public IP; repeat for IPv4 + IPv6')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('run with sudo')
    if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', args.domain):
        parser.error('invalid domain')
    addresses = [str(ipaddress.ip_network(value, strict=False)) for value in args.server_ip]
    if any(ipaddress.ip_network(value).num_addresses != 1 for value in addresses):
        parser.error('--server-ip must be a single address, not a subnet')
    if not Path('/opt/webshot/node/bin/node').is_file():
        parser.error('run deploy/bootstrap.py first')
    os.environ['PATH']='/opt/webshot/node/bin:'+os.environ.get('PATH','/usr/bin:/bin')
    try:
        account = pwd.getpwnam('webshot')
    except KeyError:
        run('useradd', '--system', '--home-dir', '/var/lib/webshot', '--create-home', '--shell', '/usr/sbin/nologin', 'webshot')
        account = pwd.getpwnam('webshot')
    root = Path('/opt/webshot/app')
    root.mkdir(parents=True, exist_ok=True)
    if root.resolve() != REPO.resolve():
        for pattern in ('*.mjs', 'package.json', 'package-lock.json', 'README.md'):
            for source in REPO.glob(pattern):
                shutil.copy2(source, root / source.name)
        for directory in ('public', 'test', 'edge'):
            shutil.copytree(REPO / directory, root / directory, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns('node_modules', '.wrangler', '.dev.vars*', 'wrangler.jsonc'))
    run('/opt/webshot/node/bin/npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', str(root))
    tests = sorted(str(p) for p in (root / 'test').glob('*.test.mjs'))
    run('/opt/webshot/node/bin/node', '--test', *tests)
    state = Path('/var/lib/webshot')
    state.mkdir(exist_ok=True)
    state.chmod(0o700)
    os.chown(state, account.pw_uid, account.pw_gid)
    env = Path('/etc/webshot.env')
    write(env, merged_environment(env.read_text() if env.exists() else '', args.domain), 0o600)
    for name in ('webshot.service', 'webshot-egress.service'):
        write('/etc/systemd/system/' + name, (TEMPLATES / name).read_text())
    write('/usr/local/sbin/webshot-egress', (REPO / 'deploy/egress.py').read_text(), 0o755)
    write('/etc/webshot-egress.json', json.dumps({'server_addresses': addresses}), 0o644)
    with urllib.request.urlopen('https://api.cloudflare.com/client/v4/ips', timeout=20) as response:
        data = json.loads(response.read(16384))
    if not data.get('success'):
        raise RuntimeError('Cloudflare IP list failed')
    ranges = [str(ipaddress.ip_network(value)) for value in data['result']['ipv4_cidrs'] + data['result']['ipv6_cidrs']]
    config = '\n'.join('set_real_ip_from ' + cidr + ';' for cidr in ranges)
    config += '\nreal_ip_header CF-Connecting-IP;\nreal_ip_recursive on;\ngeo $realip_remote_addr $webshot_cloudflare_peer {\n  default 0;\n'
    config += '\n'.join('  ' + cidr + ' 1;' for cidr in ranges)
    config += '\n}\nmap "$webshot_cloudflare_peer:$http_cf_ipcountry" $webshot_country {\n  default XX;\n  "~^1:([A-Z]{2})$" $1;\n}\nupstream webshot_backend { server 127.0.0.1:3030; keepalive 16; }\n'
    write('/etc/nginx/conf.d/webshot-cloudflare.conf', config)
    write('/etc/nginx/snippets/webshot-proxy.conf', (TEMPLATES / 'webshot-proxy.conf').read_text())
    vhost = Path('/etc/nginx/sites-available/webshot')
    if not vhost.exists():
        write(vhost, (TEMPLATES / 'webshot-http.conf').read_text().replace('__DOMAIN__', args.domain))
    link = Path('/etc/nginx/sites-enabled/webshot')
    if not link.exists():
        link.symlink_to(vhost)
    Path('/var/www/letsencrypt/.well-known/acme-challenge').mkdir(parents=True, exist_ok=True)
    run('nginx', '-t')
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', 'webshot-egress.service')
    run('systemctl', 'restart', 'webshot-egress.service')
    run('systemctl', 'enable', 'webshot.service')
    run('systemctl', 'restart', 'webshot.service')
    run('systemctl', 'reload', 'nginx')
    print('Installed. HTTPS and Cloudflare Worker setup are documented in docs/deployment.md.')

if __name__ == '__main__':
    main()
