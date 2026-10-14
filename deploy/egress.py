#!/usr/bin/python3
import subprocess,pwd,pathlib,json
settings=json.loads(pathlib.Path("/etc/webshot-egress.json").read_text())
uid=str(pwd.getpwnam('webshot').pw_uid)
blocked4=['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.168.0.0/16','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/4','240.0.0.0/4']
blocked6=['::/96','::ffff:0:0/96','64:ff9b::/96','64:ff9b:1::/48','100::/64','2001::/23','2001:db8::/32','2002::/16','fc00::/7','fe80::/10','ff00::/8']
for address in settings.get('server_addresses',[]):
    (blocked6 if ':' in address else blocked4).append(address)
def run(cmd,check=True):return subprocess.run(cmd,check=check,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
for binary,blocked,resolver in [('iptables',blocked4,'127.0.0.53/32'),('ip6tables',blocked6,None)]:
    run([binary,'-w','-N','WEBSHOT'],False);run([binary,'-w','-F','WEBSHOT'])
    run([binary,'-w','-A','WEBSHOT','-m','conntrack','--ctstate','ESTABLISHED,RELATED','-j','RETURN'])
    if resolver:
        for protocol in ['tcp','udp']:run([binary,'-w','-A','WEBSHOT','-d',resolver,'-p',protocol,'--dport','53','-j','RETURN'])
    for destination in blocked:run([binary,'-w','-A','WEBSHOT','-d',destination,'-j','REJECT'])
    run([binary,'-w','-A','WEBSHOT','-p','tcp','-m','multiport','--dports','80,443','-j','RETURN'])
    run([binary,'-w','-A','WEBSHOT','-j','REJECT'])
    rule=['OUTPUT','-m','owner','--uid-owner',uid,'-j','WEBSHOT']
    if run([binary,'-w','-C',*rule],False).returncode:run([binary,'-w','-I',*rule[:1],'1',*rule[1:]])
