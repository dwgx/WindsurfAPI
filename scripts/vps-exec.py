#!/usr/bin/env python3
"""Execute commands on VPS via SSH. Usage: python vps-exec.py 'command'"""
import paramiko, sys, time, os
os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

HOST = '154.40.36.22'
USER = 'root'
PASS = 'iwDN2S9NXGz2'

def run(cmd, timeout=600):
    s = paramiko.SSHClient()
    s.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    s.connect(HOST, username=USER, password=PASS, timeout=10)
    stdin, stdout, stderr = s.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    code = stdout.channel.recv_exit_status()
    s.close()
    return out, err, code

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'echo hello'
    out, err, code = run(cmd)
    if out: print(out, end='')
    if err: print(err, end='', file=sys.stderr)
    sys.exit(code)
