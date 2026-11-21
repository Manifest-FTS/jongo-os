"""Sequential, backed-up runtime-only rollout on the approved WordPress worker.

Run as root after copying this file and the sibling API helper into the root-only
recovery directory. Never print raw compose, inspect data, database or credentials.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

os.umask(0o077)
ROOT = Path('/data/coolify/backups/php-security-20261021-fleet')
IMAGE = 'wordpress:php8.3-apache@sha256:f3e6835fa7d4a5b786615c24b67ec70816e06ebd517d31276bef423e49dfd126'
OLD = {'8.3.31', '8.3.33', '8.3.35'}
ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)

def run(args, data=None, timeout=300):
    p = subprocess.run(args, input=data, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        # Raw command/output may contain secrets. Preserve protected diagnostics only.
        (ROOT / 'last-command-error.txt').write_text(p.stderr + '\n' + p.stdout)
        raise RuntimeError('Command failed; see protected last-command-error.txt')
    return p.stdout

def inspect(c):
    return json.loads(run(['docker', 'inspect', c]))[0]

def facts(c):
    code = 'echo json_encode(["php"=>PHP_VERSION,"modules"=>get_loaded_extensions(),"limits"=>array_map("ini_get",["memory_limit","post_max_size","upload_max_filesize","max_execution_time","max_input_time","max_input_vars"])]);'
    x = json.loads(run(['docker', 'exec', c, 'php', '-r', code]))
    x['modules'].sort()
    x['code'] = run(['docker', 'exec', c, 'sh', '-c', 'sha256sum /var/www/html/wp-config.php /var/www/html/wp-includes/version.php; find /var/www/html/wp-content/plugins /var/www/html/wp-content/themes -maxdepth 2 -type f -name "*.php" -exec sha256sum {} \\; | sort'])
    return x

def probes(domain):
    result = {}
    for path in ['/', '/wp-login.php', '/wp-json/']:
        # curl 8.5 can fail silently rewinding /dev/null after a retryable 503.
        # A regular temporary output file permits its normal bounded retries.
        with tempfile.NamedTemporaryFile() as body:
            p = subprocess.run(['curl', '-sS', '-L', '--max-redirs', '10', '--retry', '3', '--retry-max-time', '30', '--max-time', '40', '-o', body.name, '-w', '%{http_code}', domain.rstrip('/') + path], capture_output=True, text=True)
        result[path] = p.stdout.strip() if p.returncode == 0 else 'unreachable'
    return result

JONGO = next(c for c in run(['docker', 'ps', '--format', '{{.Names}}']).splitlines() if c.startswith('oreu338s6akv34il5gwwj0wb-'))
JS = (ROOT / 'wordpress-php-security-20261021-api.cjs').read_text()

def api(uuid, action, **kwargs):
    return json.loads(run(['docker', 'exec', '-i', JONGO, 'node', '-e', JS], json.dumps(dict(uuid=uuid, action=action, **kwargs)), timeout=120))

def restic(script):
    prefix = '''set -euo pipefail
set -a; . /root/.config/restic/b2-credentials.env; set +a
export AWS_ACCESS_KEY_ID="$B2_KEY_ID" AWS_SECRET_ACCESS_KEY="$B2_APPLICATION_KEY"
REPO="s3:${B2_ENDPOINT}/${B2_BUCKET}"
exec 9>/run/jongo-backup.lock
flock -n 9 || { echo BACKUP_BUSY >&2; exit 1; }
'''
    return run(['bash', '-c', prefix + script], timeout=1800)

def record(uuid, payload):
    (ROOT / uuid / 'result.json').write_text(json.dumps(payload, indent=2))
    print(json.dumps(payload), flush=True)

containers = [inspect(c) for c in run(['docker', 'ps', '--format', '{{.Names}}']).splitlines() if c.startswith('wordpress-')]
# Reject shared WordPress file stores before touching any site.
sources = []
for c in containers:
    files = [m for m in c['Mounts'] if m['Destination'] == '/var/www/html']
    assert len(files) == 1 and files[0]['Type'] == 'volume', 'Unsupported files mount'
    sources.append(files[0]['Source'])
assert len(sources) == len(set(sources)), 'Shared files volume; manual review needed'
# Do staging/test services before production, with GSE production first among production.
def priority(c):
    domain = c['Config']['Labels'].get('caddy_0', '')
    return (0 if any(x in domain for x in ['staging', '.stage.', 'testing.', 'sushiapi.', 'tttttt']) else 1,
            0 if 'www.gardenstateequality.org' in domain else 1, c['Name'])
containers.sort(key=priority)
print('INVENTORY_COUNT=' + str(len(containers)), flush=True)
for before in containers:
    c = before['Name'].lstrip('/')
    uuid = c.removeprefix('wordpress-')
    assert re.fullmatch('[a-z0-9]{24}', uuid)
    if uuid in os.environ.get('PHP_ROLLOUT_SKIP', '').split(','):
        print('QUARANTINED_REQUIRES_REVIEW=' + uuid, flush=True)
        continue
    dest = ROOT / uuid
    dest.mkdir(exist_ok=True, mode=0o700)
    version = run(['docker', 'exec', c, 'php', '-r', 'echo PHP_VERSION;']).strip()
    if version == '8.3.36':
        if not (dest / 'result.json').exists():
            record(uuid, dict(uuid=uuid, status='already_patched', php=version))
        else:
            print('SKIP_PATCHED=' + uuid, flush=True)
        continue
    assert version in OLD, 'Unexpected PHP branch/version; manual review needed'
    print('BEGIN=' + uuid, flush=True)
    service = api(uuid, 'read')
    (dest / 'coolify-before.json').write_text(json.dumps(service))
    apps = [a for a in service['applications'] if a['name'] == 'wordpress']
    assert len(apps) == 1 and apps[0]['fqdn'], 'Missing WordPress domain'
    domain = apps[0]['fqdn'].split(',')[0]
    assert domain.startswith('https://'), 'Unexpected domain scheme'
    labels = before['Config']['Labels']
    assert labels['com.docker.compose.project'] == uuid
    folder = Path(labels['com.docker.compose.project.working_dir'])
    assert folder == Path('/data/coolify/services') / uuid
    source = next(m['Source'] for m in before['Mounts'] if m['Destination'] == '/var/www/html')
    dbs = [x for x in run(['docker', 'ps', '--format', '{{.Names}}']).splitlines() if x in ['mysql-' + uuid, 'mariadb-' + uuid]]
    assert len(dbs) == 1, 'Expected one running site database'
    db = dbs[0]
    dbbefore = inspect(db)
    db_env = dict(s.split('=', 1) for s in dbbefore['Config']['Env'] if '=' in s)
    assert (db_env.get('MYSQL_ROOT_PASSWORD') or db_env.get('MARIADB_ROOT_PASSWORD'))
    assert (db_env.get('MYSQL_DATABASE') or db_env.get('MARIADB_DATABASE'))
    baseline = facts(c)
    assert baseline['php'] == version
    candidate = json.loads(run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'php', IMAGE, '-r', 'echo json_encode(get_loaded_extensions());']))
    assert sorted(candidate) == baseline['modules'], 'Candidate extension mismatch; refusing before deployment'
    assert shutil.disk_usage(ROOT).free > 8 * 1024**3, 'Less than 8 GiB free; refusing backup/deployment'
    endpoints = probes(domain)
    (dest / 'before.json').write_text(json.dumps(dict(facts=baseline, probes=endpoints)))
    (dest / 'container-before.json').write_text(json.dumps(before))
    if not (dest / 'compose-before').exists():
        shutil.copytree(folder, dest / 'compose-before')
    # Retain exact old image for runtime-only recovery, without moving wordpress:latest.
    run(['docker', 'image', 'tag', before['Image'], 'jongo-php-rollback:' + uuid])
    dump = dest / 'database.sql'
    with dump.open('w') as f:
        p = subprocess.run(['docker', 'exec', db, 'sh', '-c',
            'export MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; D="${MYSQL_DATABASE:-$MARIADB_DATABASE}"; if command -v mariadb-dump >/dev/null; then B=mariadb-dump; else B=mysqldump; fi; exec "$B" --single-transaction --quick --no-tablespaces --routines --triggers --events --default-character-set=utf8mb4 -uroot "$D"'], stdout=f, stderr=subprocess.PIPE, text=True, timeout=900)
    assert p.returncode == 0 and dump.stat().st_size > 100, 'Database backup failed'
    # Each snapshot captures configuration, files and a transaction-consistent DB dump.
    out = restic('restic -r "$REPO" backup --json --host ' + shlex.quote(re.sub('[^a-zA-Z0-9.-]', '-', service['name'])[:63]) +
                 ' --tag php-security-20261021-fleet --tag site=' + uuid +
                 ' --exclude "**/wp-content/cache" --exclude "*.log" ' + shlex.quote(str(dest)) + ' ' + shlex.quote(source))
    summaries = [json.loads(l) for l in out.splitlines() if l.startswith('{')]
    snapshot = next(x['snapshot_id'] for x in summaries if x.get('message_type') == 'summary')
    # Read dump back from offsite storage and hash it; no database content is printed.
    local_hash = hashlib.file_digest(dump.open('rb'), 'sha256').hexdigest()
    remote_hash = restic('restic -r "$REPO" dump ' + snapshot + ' ' + shlex.quote(str(dump)) + ' | sha256sum').split()[0]
    assert remote_hash == local_hash, 'Offsite database verification failed'
    (dest / 'backup.json').write_text(json.dumps(dict(snapshot=snapshot, databaseSha256=local_hash)))
    print('BACKUP_VERIFIED=' + uuid + ' snapshot=' + snapshot[:8], flush=True)
    # Preserve full resolved compose semantics, replacing only the WordPress image.
    compose = ['docker', 'compose', '-p', uuid, '-f', str(folder / 'docker-compose.yml')]
    override = dest / 'image.override.yml'
    override.write_text('services:\n  wordpress:\n    image: ' + IMAGE + '\n')
    patched = compose + ['-f', str(override)]
    original = json.loads(run(compose + ['config', '--format', 'json']))
    changed = json.loads(run(patched + ['config', '--format', 'json']))
    assert changed['services']['wordpress']['image'] == IMAGE
    changed['services']['wordpress']['image'] = original['services']['wordpress']['image']
    assert changed == original, 'Compose change was not image-only'
    saved = api(uuid, 'pin', expectedRaw=service['docker_compose_raw'])
    (dest / 'coolify-pinned.json').write_text(json.dumps(saved))
    try:
        # Up touches ONLY this service; database and other sites are not restarted.
        run(patched + ['up', '-d', '--no-deps', '--pull', 'never', '--wait', '--wait-timeout', '120', 'wordpress'])
        run(['docker', 'exec', c, 'php', '-r', 'if(PHP_VERSION!=="8.3.36")exit(1);'])
        after = facts(c)
        assert after['php'] == '8.3.36'
        assert after['modules'] == baseline['modules'], 'PHP extensions changed'
        assert after['limits'] == baseline['limits'], 'PHP limits changed'
        assert after['code'] == baseline['code'], 'Recorded WordPress/config/plugin/theme files changed'
        after_endpoints = probes(domain)
        (dest / 'after.json').write_text(json.dumps(dict(facts=after, probes=after_endpoints)))
        for path, status in endpoints.items():
            if status.isdigit() and int(status) < 400:
                assert after_endpoints[path] == status, 'New endpoint regression: ' + path
        dbafter = inspect(db)
        assert dbafter['Id'] == dbbefore['Id'] and dbafter['State']['StartedAt'] == dbbefore['State']['StartedAt'], 'Database container restarted'
        # Apache/PHP errors commonly go to stderr, so inspect both streams separately.
        lp = subprocess.run(['docker', 'logs', '--since', inspect(c)['State']['StartedAt'], c], capture_output=True, text=True)
        errors = len(re.findall(r'PHP (?:Fatal|Parse) error|segmentation fault', lp.stdout + lp.stderr, re.I))
        assert errors == 0, 'Fatal error in new runtime logs'
        record(uuid, dict(uuid=uuid, name=service['name'], domain=domain, status='patched', beforePhp=version, php='8.3.36', snapshot=snapshot[:8], before=endpoints, after=after_endpoints, databaseUnchanged=True, codeUnchanged=True, fatalErrors=errors))
    except Exception:
        # Restore the runtime only, never overwrite live data to roll back PHP.
        rollback = dest / 'rollback.override.yml'
        rollback.write_text('services:\n  wordpress:\n    image: jongo-php-rollback:' + uuid + '\n')
        run(compose + ['-f', str(rollback), 'up', '-d', '--no-deps', '--pull', 'never', 'wordpress'])
        api(uuid, 'restore', expectedRaw=saved['docker_compose_raw'], restoreRaw=service['docker_compose_raw'])
        record(uuid, dict(uuid=uuid, domain=domain, status='rolled_back_requires_review', snapshot=snapshot[:8]))
        raise
print('ROLLOUT_FINISHED', flush=True)