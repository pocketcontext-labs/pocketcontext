#!/usr/bin/env python3
"""Command-line client for a WikiContext knowledge-base server.

Configuration comes from environment variables:
  WIKICONTEXT_URL             server address, for example https://wiki.example.com
  WIKICONTEXT_USER_EMAIL     email of an account in the `users` collection
  WIKICONTEXT_USER_PASSWORD  password of that account (optional with Google login)
  WIKICONTEXT_SPACE          optional space ID; --space overrides it. The default is
                             company space, verified through SQL.

Exit codes: 0 success; 1 HTTP or transport error; 2 usage or configuration error;
3 `check` found schema differences; 4 HTTP 409 (read the record again, then retry).
"""
import argparse
import base64
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ENV = ['WIKICONTEXT_URL', 'WIKICONTEXT_USER_EMAIL', 'WIKICONTEXT_USER_PASSWORD']
SPACE_ENV = 'WIKICONTEXT_SPACE'
COMPANY_SPACE = 'companyspace001'
ROOTS = ('sources', 'ingestion_runs', 'pages')
SCHEMA_FILE = Path(__file__).resolve().parent / 'schema.json'
STAMPS = ('created_by', 'updated_by')
ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
TIMEOUT = 30
USER_AGENT = 'WikiContext/1.0'
hidden = []  # The password and tokens. say() masks them in everything it prints.


class Fail(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def hide(value):
    if value:
        hidden.append(value)
    return value


def say(text, stream=sys.stderr):
    for value in hidden:
        text = text.replace(value, '***')
    print(text, file=stream)


def dump(data, pretty=False):
    if pretty:
        return json.dumps(data, indent=2, ensure_ascii=False)
    return json.dumps(data, separators=(',', ':'), ensure_ascii=False)


def config(names=ENV[:2]):
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        raise Fail(2, 'missing environment variable: ' + ', '.join(missing) + '. Ask the user to set every missing variable; do not look for credentials elsewhere.')
    url = os.environ[ENV[0]].rstrip('/')
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise Fail(2, 'WIKICONTEXT_URL must be an HTTP(S) URL without credentials, query, or fragment')
    if parsed.scheme == 'http' and parsed.hostname not in ('localhost', '127.0.0.1', '::1'):
        raise Fail(2, 'Use HTTPS for a remote WikiContext server')
    space = os.environ.get(SPACE_ENV) or None
    if space is not None and not re.fullmatch(r'[a-z0-9]{15}', space):
        raise Fail(2, f'{SPACE_ENV} must be a 15-character space ID')
    return {'url': url, 'email': os.environ[ENV[1]], 'password': hide(os.environ.get(ENV[2])), 'space': space}


def space_id(cfg):
    """The selected space: explicit --space/WIKICONTEXT_SPACE, else the company space.

    Spaces are visible through SQL only to their active members, so an inaccessible
    space and an absent one are indistinguishable.
    """
    if cfg.get('space_checked'):
        return cfg['space']
    selected = cfg.get('space')
    if selected is not None:
        if not isinstance(selected, str) or not re.fullmatch(r'[a-z0-9]{15}', selected):
            raise Fail(2, 'space must be a 15-character space ID')
        sql = f"SELECT id FROM spaces WHERE id = '{selected}' LIMIT 1"
    else:
        sql = f"SELECT id FROM spaces WHERE id = '{COMPANY_SPACE}' AND kind = 'group' LIMIT 1"
    result = must(cfg, 'POST', '/api/context/query', {'sql': sql})
    if result.get('truncated'):
        raise Fail(1, 'space lookup was truncated')
    found = [row[0] for row in result.get('rows', [])]
    if selected is not None and found != [selected]:
        raise Fail(2, 'space not found or not accessible to this account; run `wikicontext spaces`')
    if selected is None:
        if len(found) != 1:
            raise Fail(1, 'company space not accessible to this account; select --space or run `wikicontext spaces`')
        selected = found[0]
    cfg['space'], cfg['space_checked'] = selected, True
    return selected


# Token cache: one file per server URL and email, readable only by the current user.

def cache_file(cfg):
    base = os.environ.get('XDG_CACHE_HOME') or str(Path.home() / '.cache')
    key = hashlib.sha256((cfg['url'] + '\n' + cfg['email']).encode()).hexdigest()[:32]
    return Path(base) / 'wikicontext' / (key + '.json')


def load_session(cfg):
    try:
        session = json.loads(cache_file(cfg).read_text())
        if not isinstance(session, dict) or session.get('url') != cfg['url'] or session.get('email') != cfg['email']:
            return None
        return session if isinstance(session.get('token'), str) and hide(session['token']) else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


def save_session(cfg, session):
    path = cache_file(cfg)
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='.session-', delete=False) as handle:
            temporary = Path(handle.name)
            os.fchmod(handle.fileno(), 0o600)
            json.dump(session, handle)
        os.replace(temporary, path)
    except OSError as error:
        say(f'note: token not cached ({error.strerror}); sign-in will be required again')


# HTTP

class NoRedirect(urllib.request.HTTPRedirectHandler):
    """A followed redirect would turn a POST into a GET and could send the token to another host."""
    def redirect_request(self, *args):
        return None


opener = urllib.request.build_opener(NoRedirect)


def send(cfg, method, path, body=None, token=None, timeout=TIMEOUT):
    """Send one request. Returns (status, parsed JSON body, or the text when it is not JSON)."""
    headers = {'Content-Type': 'application/json', 'User-Agent': USER_AGENT}
    if token:
        headers['Authorization'] = token
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(cfg['url'] + path, data=data, headers=headers, method=method)
    try:
        with opener.open(request, timeout=timeout) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
        if 300 <= status < 400:
            raise Fail(1, f'HTTP {status}: the server redirects to {error.headers.get("Location")}. Set WIKICONTEXT_URL to the final address.')
    except (OSError, ValueError, http.client.HTTPException) as error:
        reason = getattr(error, 'reason', error)
        raise Fail(1, f'cannot reach {cfg["url"]}: {reason}')
    text = raw.decode('utf-8', 'replace')
    try:
        return status, json.loads(text) if text else None
    except ValueError:
        return status, text[:2000]


def login(cfg):
    if not cfg.get('password'):
        raise Fail(2, 'Set WIKICONTEXT_USER_PASSWORD for password login, or run wikicontext login --google for browser sign-in.')
    status, data = send(cfg, 'POST', '/api/collections/users/auth-with-password', {'identity': cfg['email'], 'password': cfg['password']})
    if status != 200 or not isinstance(data, dict) or 'token' not in data:
        raise Fail(1, f'login as {cfg["email"]} failed: HTTP {status}\n{dump(data)}\nCheck the three WIKICONTEXT_ variables with the user. User credentials only.')
    session = {'url': cfg['url'], 'email': cfg['email'], 'token': hide(data['token'])}
    save_session(cfg, session)
    return session


def auth_session(cfg, data, method):
    """Accept only the expected users identity; never retain provider metadata."""
    token = data.get('token') if isinstance(data, dict) else None
    if isinstance(token, str):
        hide(token)
    record = data.get('record') if isinstance(data, dict) else None
    if (not isinstance(token, str) or not token or not isinstance(record, dict) or record.get('collectionName') != 'users'
            or not record.get('id') or not isinstance(record.get('email'), str)
            or record['email'].casefold() != cfg['email'].casefold()):
        raise Fail(1, 'Authentication returned an unexpected identity; no session saved. Check WIKICONTEXT_USER_EMAIL.')
    session = {'url': cfg['url'], 'email': cfg['email'], 'token': token, 'method': method, 'refreshed_at': time.time()}
    save_session(cfg, session)
    return session


def oauth_send(cfg, method, path, body=None, token=None):
    try:
        return send(cfg, method, path, body, token)
    except Fail:
        # Redirect locations and transport errors may contain authorization credentials.
        raise Fail(1, 'OAuth authentication request failed; check the server URL and connection, then retry.') from None


def oauth_refresh_needed(session):
    """Unverified JWT claims only schedule renewal; the server always authenticates the token."""
    try:
        payload = session['token'].split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        now = time.time()
        refreshed_at = session['refreshed_at']
        return (not 0 <= now - refreshed_at < 300 or claims['exp'] <= now + 60)
    except (ValueError, TypeError, KeyError, IndexError):
        return True


def google_login(cfg, port=8765, timeout=180):
    if not 1 <= port <= 65535 or not 1 <= timeout <= 600:
        raise Fail(2, 'OAuth port must be 1–65535 and timeout must be 1–600 seconds')
    status, data = oauth_send(cfg, 'GET', '/api/collections/users/auth-methods')
    oauth = data.get('oauth2', {}) if isinstance(data, dict) else {}
    providers = oauth.get('providers', [])
    provider = next((p for p in providers if isinstance(p, dict) and p.get('name') == 'google'), None)
    if status != 200 or not oauth.get('enabled') or not provider:
        raise Fail(1, 'Google OAuth is not enabled on this WikiContext server.')
    auth_url = urllib.parse.urlsplit(provider.get('authURL', ''))
    if auth_url.scheme != 'https' or auth_url.hostname != 'accounts.google.com' or auth_url.username or auth_url.password or auth_url.fragment:
        raise Fail(1, 'Server returned an unexpected Google authorization URL.')
    state = secrets.token_urlsafe(32)
    verifier = hide(secrets.token_urlsafe(48))
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    redirect = f'http://127.0.0.1:{port}/callback'
    metadata = urllib.parse.parse_qs(auth_url.query)
    client_ids = metadata.get('client_id', [])
    if len(client_ids) != 1 or not client_ids[0]:
        raise Fail(1, 'Server returned an invalid Google client ID.')
    params = {'client_id': client_ids[0]}
    params.update(state=state, code_challenge=challenge, code_challenge_method='S256', redirect_uri=redirect,
                  login_hint=cfg['email'], response_type='code', scope='openid email profile', access_type='online')
    url = urllib.parse.urlunsplit(auth_url._replace(query=urllib.parse.urlencode(params)))
    outcome = {}

    class Callback(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Callback URLs contain credentials.

        def do_GET(self):
            parsed = urllib.parse.urlsplit(self.path)
            values = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            code = values.get('code', [])
            valid_state = values.get('state', [])
            valid = (self.headers.get('Host') == f'127.0.0.1:{port}' and parsed.path == '/callback' and len(valid_state) == 1
                     and secrets.compare_digest(valid_state[0], state))
            if not valid:
                status, message = 400, 'Invalid sign-in callback. Return to your terminal.'
            elif 'error' in values:
                outcome['error'] = 'Google sign-in was denied or cancelled; run wikicontext login --google to retry.'
                status, message = 400, 'Sign-in was cancelled. Return to your terminal.'
            elif len(code) != 1 or not code[0]:
                outcome['error'] = 'Google returned an invalid sign-in callback.'
                status, message = 400, 'Invalid sign-in callback. Return to your terminal.'
            else:
                outcome['code'] = hide(code[0])
                status, message = 200, 'Authorization received. Return to your terminal to check sign-in.'
            self.send_response(status)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            self.wfile.write(message.encode())

    class Listener(http.server.HTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(1)
            return connection, address

        def handle_error(self, request, client_address):
            pass  # Never print request data or exception tracebacks.

    try:
        server = Listener(('127.0.0.1', port), Callback)
    except OSError:
        raise Fail(1, f'Cannot listen on 127.0.0.1:{port}; check for another login process or choose --port.')
    with server:
        server.timeout = 0.25
        say(f'For SSH, forward this port: ssh -L {port}:127.0.0.1:{port} user@ssh-host')
        say('Open this URL in your browser (keep it private):\n' + url)
        deadline = time.monotonic() + timeout
        while not outcome and time.monotonic() < deadline:
            server.handle_request()
    if not outcome:
        raise Fail(1, 'Google sign-in timed out; run wikicontext login --google to retry.')
    if 'error' in outcome:
        raise Fail(1, outcome['error'])
    status, data = oauth_send(cfg, 'POST', '/api/collections/users/auth-with-oauth2', {
        'provider': 'google', 'code': outcome['code'], 'codeVerifier': verifier, 'redirectURL': redirect,
    })
    if status != 200:
        raise Fail(1, f'Google sign-in failed: HTTP {status}. Check Workspace eligibility, account access, and the redirect URI with your operator.')
    return auth_session(cfg, data, 'google')


def token_rejected(cfg, token):
    return send(cfg, 'POST', '/api/context/query', {'sql': 'SELECT 1'}, token)[0] == 401


def call(cfg, method, path, body=None):
    """Authenticated request. Returns (status, data).

    Only the SQL endpoints answer an expired or revoked token with 401. The records API treats it as no
    token and answers 400, 403, or 404. So after such an error with a cached token, check the token,
    and if the server rejects it, log in once and send the request once more. The first attempt wrote nothing.
    """
    session = load_session(cfg)
    cached = session is not None
    if not cached:
        session = login(cfg)
    if session.get('method') == 'google' and (oauth_refresh_needed(session) or path == '/api/collections/users/auth-refresh'):
        # Renew at most every five minutes, or near expiry, to respect auth rate limits.
        status, data = oauth_send(cfg, 'POST', '/api/collections/users/auth-refresh', token=session['token'])
        if status != 200:
            raise Fail(1, f'Google session could not be refreshed (HTTP {status}); run wikicontext login --google again.')
        session = auth_session(cfg, data, 'google')
        if path == '/api/collections/users/auth-refresh':
            return status, data
    status, data = send(cfg, method, path, body, session['token'])
    if cached and 400 <= status < 500 and status not in (409, 429) and (status == 401 or token_rejected(cfg, session['token'])):
        if session.get('method') == 'google':
            raise Fail(1, 'Google session was rejected; run wikicontext login --google again.')
        session = login(cfg)
        status, data = send(cfg, method, path, body, session['token'])
    return status, data


def batch_failures(data):
    """The failed requests of a rejected batch as (index, status, message). The server reports them under data.requests."""
    try:
        failures = []
        for index, entry in data['data']['requests'].items():
            response = entry['response']
            fields = [f'{name}: {detail.get("message")}' for name, detail in (response.get('data') or {}).items() if isinstance(detail, dict)]
            failures.append((index, response.get('status'), ' '.join([response.get('message') or ''] + fields)))
        return failures
    except (AttributeError, KeyError, TypeError):
        return []


def must(cfg, method, path, body=None):
    """Like call(), but an HTTP error ends the command with the server's status and body on stderr."""
    status, data = call(cfg, method, path, body)
    safe_read = (method == 'GET' or path in ('/api/context/query', '/api/context/search', '/api/files/token'))
    for attempt in range(3):
        if not safe_read or status not in (429, 503):
            break
        time.sleep(10 if status == 429 else .5 * (attempt + 1))
        status, data = call(cfg, method, path, body)
    if status < 400:
        return data
    lines = [f'HTTP {status} from {method} {path}', dump(data, pretty=True)]
    conflict = status == 409
    if path == '/api/batch':
        lines.append('Nothing in this batch was saved.')
        for index, inner_status, message in batch_failures(data):
            lines.append(f'Failed request index {index}: HTTP {inner_status}: {message}')
            conflict = conflict or inner_status == 409
    if conflict:
        lines.append('HTTP 409: another request changed the record first. Read it again, confirm the change still applies, then retry.')
    raise Fail(4 if conflict else 1, '\n'.join(lines))


# Commands

def read_json(text, kind, what):
    if text == '-':
        text = sys.stdin.read()
    try:
        value = json.loads(text)
    except ValueError as error:
        raise Fail(2, f'{what} is not valid JSON: {error}')
    if not isinstance(value, kind):
        raise Fail(2, f'{what} must be a JSON {"array" if kind is list else "object"}')
    return value


def require_revision(body):
    if type(body.get('expected_revision')) is not int or body['expected_revision'] < 1:
        raise Fail(2, 'updates require expected_revision from your last read; read the record before changing it')


def record_body(text):
    body = read_json(text, dict, 'the record body')
    for field in STAMPS:
        if field in body:
            del body[field]
            say(f'note: removed {field} from the body; the server sets it from your login')
    if not body:
        raise Fail(2, 'the record body has no fields to send')
    return body


def records(collection, record=None):
    path = f'/api/collections/{urllib.parse.quote(collection, safe="")}/records'
    return path if record is None else f'{path}/{urllib.parse.quote(record, safe="")}'


def columns(tables):
    return {table['name']: {column['name']: column.get('type') for column in table['columns']} for table in tables}


def check(cfg):
    """Compare the live SQL schema with references/schema.json. Returns the exit code."""
    try:
        reference = columns(json.loads(SCHEMA_FILE.read_text())['tables'])
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise Fail(2, f'cannot read {SCHEMA_FILE}: {error}')
    live = columns(must(cfg, 'GET', '/api/context/schema')['tables'])
    differences = []
    for table in sorted(set(live) | set(reference)):
        if table not in reference:
            differences.append(f'table {table}: on the server, not in the reference files')
        elif table not in live:
            differences.append(f'table {table}: in the reference files, not on the server')
        else:
            for column in sorted(set(live[table]) | set(reference[table])):
                if column not in reference[table]:
                    differences.append(f'column {table}.{column}: on the server, not in the reference files')
                elif column not in live[table]:
                    differences.append(f'column {table}.{column}: in the reference files, not on the server')
                elif live[table][column] != reference[table][column]:
                    differences.append(f'column {table}.{column}: type {live[table][column]} on the server, {reference[table][column]} in the reference files')
    if not differences:
        say(f'OK: the live schema matches references/schema.json ({len(live)} tables)', sys.stdout)
        return 0
    for line in differences:
        say(line, sys.stdout)
    say('The server is authoritative: run `wikicontext schema` and follow the server\'s error messages where the reference files disagree. '
        'Ask the user to update this skill.', sys.stdout)
    return 3


def home_fields(cfg, args):
    """Capture an explicit staging choice; publishing never refreshes its base."""
    changing = args.home is not None or args.clear_home
    if args.home_base is not None and not changing:
        raise Fail(2, '--home-base requires --home or --clear-home')
    if not changing:
        return {}
    if args.home_base is not None and args.home_base != '' and not re.fullmatch(r'[a-z0-9]{15}', args.home_base):
        raise Fail(2, '--home-base must be a page ID or an empty string')
    if args.command == 'publish' and args.home_base is None:
        raise Fail(2, 'publish home changes require explicit --home-base; use stage-home to capture the expected home earlier')
    if args.home is not None and not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', args.home):
        raise Fail(2, '--home must be a page slug')
    def rows(sql):
        result = must(cfg, 'POST', '/api/context/query', {'sql': sql})
        if result.get('truncated'):
            raise Fail(1, 'home selection query was truncated')
        return [dict(zip(result['columns'], row)) for row in result['rows']]
    base = args.home_base
    if base is None:
        runs = rows(f"SELECT space, home, clear_home FROM ingestion_runs WHERE id = '{args.run_id}' LIMIT 1")
        if not runs:
            raise Fail(1, 'staging run not found')
        if runs[0]['home'] or runs[0]['clear_home']:
            raise Fail(2, 'run already has a staged home choice; preserve it with publish, or reassess and supply explicit --home-base')
        # The latest publication and page slugs belong to the run's own space.
        space = runs[0]['space']
        publications = rows(f"SELECT home FROM publications WHERE space = '{space}' ORDER BY sequence DESC LIMIT 1")
        base = publications[0]['home'] if publications else ''
    else:
        runs = rows(f"SELECT space FROM ingestion_runs WHERE id = '{args.run_id}' LIMIT 1")
        if not runs:
            raise Fail(1, 'staging run not found')
        space = runs[0]['space']
    if not isinstance(space, str) or not re.fullmatch(r'[a-z0-9]{15}', space):
        raise Fail(1, 'staging run has an invalid space')
    home = ''
    if args.home is not None:
        pages = rows(f"SELECT id FROM pages WHERE slug = '{args.home}' AND space = '{space}' LIMIT 1")
        if not pages:
            raise Fail(2, f'home page slug not found: {args.home}')
        home = pages[0]['id']
    return {'home': home, 'home_base': base or '', 'clear_home': args.clear_home}


def run(args):
    if args.command == 'newid':
        print(''.join(secrets.choice(ID_ALPHABET) for _ in range(15)))
        return 0
    if args.command == 'logout':
        cfg = config(ENV[:2])
        path = cache_file(cfg)
        path.unlink(missing_ok=True)
        say(f'removed {path}', sys.stdout)
        return 0
    cfg = config()
    if args.space is not None:
        cfg['space'] = args.space
    if args.command == 'ingest':
        from . import ingest
        result = ingest.ingest(cfg, args.path, title=args.title, version=args.version,
                               audio_storage=args.audio_storage, image_review=args.image_review,
                               transcript_bundle=args.transcript_bundle, audio_provider=args.audio_provider,
                               pipeline=args.pipeline, language=args.language,
                               translation_language=args.translation_language, resume=args.resume)
        say(dump(result, args.pretty), sys.stdout)
        return 0
    if args.command == 'stage-audio':
        from . import audio_catalog
        try:
            receipt_text = sys.stdin.read() if args.receipt == '-' else Path(args.receipt).read_text()
            receipt = json.loads(receipt_text)
        except (OSError, ValueError):
            raise Fail(2, 'Audio receipt must be a readable JSON file or stdin; no staging attempted.') from None
        if not isinstance(receipt, dict):
            raise Fail(2, 'Audio receipt must be a JSON object.')
        result = audio_catalog.stage(cfg, args.run_id, receipt, args.transcript_page, args.summary_page,
                                     title=args.title, language=args.language, duration_seconds=args.duration_seconds)
        say(dump(result, args.pretty), sys.stdout)
        return 0
    if args.command == 'export-repository-file':
        from . import repository_files
        say(dump(repository_files.export(cfg, args.destination_id, args.output, args.sequence), args.pretty), sys.stdout)
        return 0
    if args.command == 'export-obsidian':
        from . import exporter
        say(dump(exporter.export(cfg, args.destination, sequence=args.sequence), args.pretty), sys.stdout)
        return 0
    if args.command in ('search', 'lint'):
        from . import knowledge
        data = (knowledge.search(cfg, args.term, publication_id=args.publication, sequence=args.sequence,
                                 limit=args.limit, offset=args.offset, generation=args.generation)
                if args.command == 'search' else knowledge.lint(cfg))
        say(dump(data, args.pretty), sys.stdout)
        return 0
    if args.command in ('publish', 'stage-home'):
        if not re.fullmatch(r'[a-z0-9]{15}', args.run_id) or args.expected_revision < 1:
            raise Fail(2, 'Valid run ID and positive expected revision required')
        body = {'expected_revision': args.expected_revision, **home_fields(cfg, args)}
        if args.command == 'publish':
            body['status'] = 'published'
        data = must(cfg, 'PATCH', records('ingestion_runs', args.run_id), body)
        say(dump(data, args.pretty), sys.stdout)
        return 0
    if args.command == 'login':
        google_login(cfg, args.port, args.timeout)
        say(f'Signed in as {cfg["email"]} at {cfg["url"]}', sys.stdout)
        return 0
    # Reject malformed writes before authentication or any network request.
    body = None
    if args.command in ('create', 'update'):
        body = record_body(args.json)
        if args.command == 'update':
            require_revision(body)
    elif args.command == 'batch':
        requests = read_json(args.json, list, 'the batch')
        if not all(isinstance(entry, dict) for entry in requests):
            raise Fail(2, 'each batch entry must be an object with method, url, and body')
        for entry in requests:
            method, url = entry.get('method'), entry.get('url', '')
            if method not in ('POST', 'PATCH') or not isinstance(url, str) or not re.fullmatch(r'/api/collections/(sources|renditions|passages|ingestion_runs|pages|page_revisions|citations|page_links)/records(?:/[a-z0-9]{15})?', url):
                raise Fail(2, 'batch accepts only POST/PATCH business record URLs')
            if not isinstance(entry.get('body'), dict):
                raise Fail(2, 'each batch body must be an object')
            if method == 'PATCH':
                require_revision(entry['body'])
        body = {'requests': requests}
    if args.command in ('create', 'batch'):
        # Root records go to the selected space; children inherit their parent's space.
        entries = [(args.collection, body)] if args.command == 'create' else [
            (entry['url'].split('/')[3], entry['body']) for entry in requests if entry['method'] == 'POST']
        for collection, entry in entries:
            if collection in ROOTS and 'space' not in entry:
                entry['space'] = space_id(cfg)
    if args.command == 'check':
        return check(cfg)
    if args.command == 'whoami':
        # OAuth calls persist refreshed tokens; password sessions keep their existing recovery behavior.
        refreshed = must(cfg, 'POST', '/api/collections/users/auth-refresh')
        hide(refreshed.get('token'))
        record = refreshed['record']
        data = {'id': record['id'], 'name': record.get('name', ''), 'email': cfg['email'], 'url': cfg['url'], 'space': space_id(cfg)}
    elif args.command == 'create-personal-space':
        data = must(cfg, 'POST', '/api/wiki/spaces/personal', {})
    elif args.command == 'spaces':
        refreshed = must(cfg, 'POST', '/api/collections/users/auth-refresh')
        hide(refreshed.get('token'))
        account = refreshed['record']['id']
        if not re.fullmatch(r'[a-z0-9]{15}', account):
            raise Fail(1, 'unexpected account ID')
        result = must(cfg, 'POST', '/api/context/query', {'sql':
            'SELECT s.id, s.kind, s.name, m.role FROM spaces s JOIN space_members m ON m.space = s.id '
            f"WHERE m.account = '{account}' AND m.active = 1 ORDER BY s.kind = 'group', s.name, s.id"})
        if result.get('truncated'):
            raise Fail(1, 'space listing was truncated')
        selected = cfg.get('space') or COMPANY_SPACE
        data = [dict(zip(result['columns'], row), selected=row[0] == selected) for row in result['rows']]
    elif args.command == 'schema':
        data = must(cfg, 'GET', '/api/context/schema')
    elif args.command in ('sql', 'query'):
        query = sys.stdin.read() if args.query == '-' else args.query
        data = must(cfg, 'POST', '/api/context/query', {'sql': query})
        if isinstance(data, dict) and data.get('truncated'):
            say(f'WARNING: result truncated to {len(data.get("rows", []))} rows by the server\'s row or byte limit. Select fewer columns, narrow the query, or page with ORDER BY and LIMIT/OFFSET.')
    elif args.command == 'get':
        if not re.fullmatch(r'[a-z0-9]{15}', args.id):
            raise Fail(2, 'record id must be 15 lowercase letters or digits')
        schema = must(cfg, 'GET', '/api/context/schema')
        table = next((table for table in schema['tables'] if table['name'] == args.collection), None)
        if table is None or not any(column['name'] == 'id' for column in table['columns']):
            raise Fail(2, 'collection is not an SQL-readable table with an id column')
        identifier = '"' + table['name'].replace('"', '""') + '"'
        result = must(cfg, 'POST', '/api/context/query', {
            'sql': f"SELECT * FROM {identifier} WHERE id = '{args.id}' LIMIT 1"
        })
        if result.get('truncated'):
            raise Fail(1, 'record exceeds the SQL response limit; query only the needed fields')
        if not result['rows']:
            raise Fail(1, f'HTTP 404: record not found in {args.collection}')
        data = dict(zip(result['columns'], result['rows'][0]))
    elif args.command == 'create':
        data = must(cfg, 'POST', records(args.collection), body)
    elif args.command == 'update':
        data = must(cfg, 'PATCH', records(args.collection, args.id), body)
    elif args.command == 'batch':
        data = must(cfg, 'POST', '/api/batch', body)
    say(dump(data, args.pretty), sys.stdout)
    return 0


def parse(argv):
    pretty = argparse.ArgumentParser(add_help=False)
    pretty.add_argument('--pretty', action='store_true', default=argparse.SUPPRESS, help='indent the JSON output')
    pretty.add_argument('--space', default=argparse.SUPPRESS, help=f'space ID for space-scoped commands (default: {SPACE_ENV}, else the company space)')
    parser = argparse.ArgumentParser(prog='wikicontext', parents=[pretty], description='WikiContext knowledge-base client. Reads with SQL, writes through the records API. There is no delete command: users cannot delete records.',
                                     epilog='Environment: ' + ', '.join(ENV + [SPACE_ENV]) + '. JSON arguments may be "-" to read standard input. Exit codes: 0 ok, 1 HTTP or transport error, 2 usage or configuration, 3 check found differences, 4 HTTP 409.')
    commands = parser.add_subparsers(dest='command', required=True, metavar='command')
    def add(name, text, *arguments):
        command = commands.add_parser(name, parents=[pretty], help=text, description=text)
        for argument, argument_help in arguments:
            command.add_argument(argument, help=argument_help)
    oauth_login = commands.add_parser('login', help='sign in with Google using a browser and a loopback callback')
    oauth_login.add_argument('--google', action='store_true', required=True)
    oauth_login.add_argument('--port', type=int, default=8765, help='loopback callback port; register the matching redirect URI')
    oauth_login.add_argument('--timeout', type=int, default=180, help='seconds to wait for the browser (1–600)')
    add('whoami', 'print the user id, name, server URL and selected space')
    add('spaces', 'list your spaces, roles and the selected space')
    add('create-personal-space', 'explicitly create or return your personal space; does not change the default company space')
    add('check', 'compare the live schema with references/schema.json; exit 3 when they differ')
    add('schema', 'print the live SQL tables and columns')
    add('query', 'run one read-only SELECT', ('query', 'SQL text, or - for standard input'))
    add('sql', 'run one read-only SELECT', ('query', 'SQL text, or - for standard input'))
    add('get', 'read one record as an SQL row object', ('collection', 'collection name'), ('id', 'record id'))
    add('create', 'create one record', ('collection', 'collection name'), ('json', 'JSON object, or -'))
    add('update', 'change fields of one record', ('collection', 'collection name'), ('id', 'record id'), ('json', 'JSON object with the fields to change, or -'))
    add('batch', 'send up to 20 writes as one transaction', ('json', 'JSON array of {"method","url","body"}, or -'))
    add('newid', 'print a new 15-character record id for use inside a batch')
    add('logout', 'remove the cached token')
    source = commands.add_parser('ingest', parents=[pretty], help='store a source (audio normalized by default) and extract evidence passages')
    source.add_argument('path')
    source.add_argument('--title')
    source.add_argument('--version', default='v1')
    source.add_argument('--transcript-bundle', metavar='MANIFEST', help='Import a complete Gemini evidence bundle without model calls; requires original audio storage.')
    source.add_argument('--image-review', metavar='JSON',
                        help='reviewed image passages and provenance JSON; required for PNG/JPEG/WebP')
    source.add_argument('--audio-storage', choices=('normalized', 'original'), default='normalized',
                        help='store normalized Opus audio (default), or preserve input bytes')
    source.add_argument('--audio-provider', choices=('gemini', 'groq'), default='gemini',
                        help='Audio transcription provider (default: Gemini); Groq is the explicit legacy route.')
    source.add_argument('--pipeline', choices=('standard', 'long-decode'), default='standard',
                        help='Gemini generation pipeline (default: standard); no automatic fallback.')
    source.add_argument('--language', help='Expected source language; transcript remains in its original language.')
    source.add_argument('--translation-language', help='Gemini translation language (default: English).')
    source.add_argument('--resume', metavar='WORKFLOW_RECEIPT',
                        help='Explicitly resume the saved WikiContext audio workflow; completed stages are reused.')
    audio = commands.add_parser('stage-audio', parents=[pretty], help='stage a recording catalog entry with reviewed transcript and summary links')
    audio.add_argument('run_id')
    audio.add_argument('--receipt', required=True, help='Saved ingest JSON receipt file, or - for stdin.')
    audio.add_argument('--transcript-page', required=True, help='Reviewed transcript page ID in this publication or staging run.')
    audio.add_argument('--summary-page', required=True, help='Reviewed summary page ID in this publication or staging run.')
    audio.add_argument('--title')
    audio.add_argument('--language')
    audio.add_argument('--duration-seconds', type=float)
    repository = commands.add_parser('export-repository-file', parents=[pretty], help='create a new repository copy from an explicit publication')
    repository.add_argument('destination_id', help='repository_destination page ID')
    repository.add_argument('output', help='new output file; parent directories must exist')
    repository.add_argument('--sequence', type=int, required=True)
    export = commands.add_parser('export-obsidian', parents=[pretty], help='render a pinned publication and originals into a vault root')
    export.add_argument('destination')
    export.add_argument('--sequence', type=int)
    for name, description in [('publish', 'atomically publish a staging run after revision checks'),
                              ('stage-home', 'stage a home choice and capture its expected published home')]:
        publish = commands.add_parser(name, parents=[pretty], help=description)
        publish.add_argument('run_id')
        publish.add_argument('--expected-revision', type=int, required=True)
        home = publish.add_mutually_exclusive_group(required=name == 'stage-home')
        home.add_argument('--home', help='page slug to select as home')
        home.add_argument('--clear-home', action='store_true', help='restore the welcome index')
        publish.add_argument('--home-base', help='expected current home page ID, or empty string; required for publish home flags')
    search = commands.add_parser('search', parents=[pretty], help='rank published revision text with bounded full-text search')
    search.add_argument('term', help='literal token terms; all terms must match')
    scope = search.add_mutually_exclusive_group()
    scope.add_argument('--publication', help='immutable publication record ID; defaults to latest')
    scope.add_argument('--sequence', type=int, help='historical publication sequence')
    search.add_argument('--limit', type=int, default=20, help='result page size, 1–100')
    search.add_argument('--offset', type=int, default=0, help='result offset, 0–10000')
    search.add_argument('--generation', help='returned index generation, required for continuation')
    add('lint', 'check published graph structure; semantic review remains agent work')
    args = parser.parse_args(argv)
    args.pretty = getattr(args, 'pretty', False)
    args.space = getattr(args, 'space', None)
    if args.space is not None and not re.fullmatch(r'[a-z0-9]{15}', args.space):
        parser.error('--space must be a 15-character space ID')
    return args


def _main():
    try:
        return run(parse(sys.argv[1:]))
    except Fail as error:
        say(f'wikicontext: {error}')
        return error.code
    except KeyboardInterrupt:
        return 130
    except Exception as error:  # No traceback: keep the output short and free of request data.
        say(f'wikicontext: unexpected {type(error).__name__}: {error}')
        return 1


def main():
    from observecontext_client.instrumentation import instrument_cli
    with instrument_cli(service='wikicontext.client', opener=opener):
        return _main()


if __name__ == '__main__':
    sys.exit(main())
