"""Print Claude Code's own usage panel as JSON: no sign-in, nothing answered, no prompt sent.

Starts a new, separate `claude` process (never --continue or --resume, so it cannot attach to a
session that is already running) in its own terminal and process group, with no tools, types only
the built-in /usage command, reads the panel and stops that process group. The panel states the
session's own model use; unless it says zero input and zero output tokens, the reading is refused. Prints {"observedAt": ms, "windows": [{"name", "used", "resetsAt", "minutes"}]}
or null. It refuses (null) if Claude asks anything: folder trust, sign-in or permissions. Run it
from a folder Claude already trusts. The panel may first show a remembered number and then a
newer one; the last number under each heading is kept.
"""
import datetime, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time
from zoneinfo import ZoneInfo

ANSI = re.compile(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[78]|[\x00-\x08\x0b-\x1f]')
MONTHS = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')
ASKING = re.compile(r'Enter y/n|Permission Required|Sign in|/login|password|MFA', re.I)


def plain(text):
    return ANSI.sub('', re.sub(r'\x1b\[[0-9;]*[ABCDEFGHfJK]', '\n', text)).replace('\r', '')


def reset_at(row, observed):
    m = re.fullmatch(r'Resets (?:([A-Z][a-z]{2}) (\d{1,2}) at )?(\d{1,2})(?::(\d{2}))?(am|pm) \(([^()]+)\)', row)
    month, day, hour, minute, half, zone = m.groups()
    now = datetime.datetime.fromtimestamp(observed / 1000, ZoneInfo(zone))
    hour = int(hour) % 12 + (12 if half == 'pm' else 0)
    year = now.year + (1 if month == 'Jan' and now.month == 12 else 0)
    at = datetime.datetime(year, MONTHS.index(month) + 1 if month else now.month, int(day) if day else now.day, hour, int(minute or 0), tzinfo=ZoneInfo(zone))
    if not month and at <= now:
        at += datetime.timedelta(days=1)
    return int(at.timestamp() * 1000)


def parse(text, observed):
    text = plain(text)
    marker = re.search(r'Status\s+Config\s+Usage', text)
    if not marker or ASKING.search(text):
        return None
    # The panel reports this session's own model use. Anything but zero means a model turn happened: refuse.
    session = re.findall(r'Usage:\s+(\d+) input, (\d+) output', text)
    if not session or any(row != ('0', '0') for row in session):
        return None
    windows, name = {}, None
    for row in (line.strip() for line in text[marker.end():].splitlines()):
        used = re.fullmatch(r'(\d{1,3})%(?:\s+\d{1,3}%)? used', row)
        if row.startswith('Current '):
            name = row
            windows.setdefault(name, {'name': name, 'minutes': 300 if 'session' in row else 10080 if 'week' in row else None})
        elif name and used and int(used.group(1)) <= 100:
            windows[name]['used'] = int(used.group(1)) / 100
        elif name and row.startswith('Resets '):
            try:
                windows[name]['resetsAt'] = reset_at(row, observed)
            except (AttributeError, ValueError, KeyError):
                pass
    complete = [w for w in windows.values() if 'used' in w and 'resetsAt' in w]
    return {'observedAt': observed, 'windows': complete} if complete else None


def read_panel(seconds=8):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 60, 160, 0, 0))
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG') if k in os.environ}
    env['TERM'] = 'xterm-256color'
    args = ['claude', '--safe-mode', '--setting-sources', '', '--strict-mcp-config', '--no-chrome', '--tools', '', '--permission-mode', 'dontAsk', '--ax-screen-reader']
    child = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True, close_fds=True)
    os.close(slave)
    text, sent, deadline = '', False, time.monotonic() + seconds
    try:
        while time.monotonic() < deadline and child.poll() is None:
            if not select.select([master], [], [], .15)[0]:
                continue
            data = os.read(master, 8192)
            if not data:
                break
            text += data.decode('utf-8', errors='replace')
            if ASKING.search(plain(text)) or len(text) > 262144:
                return None
            if not sent and re.search(r'(?:^|\n)[$>❯]\s*$', plain(text)):
                os.write(master, b'/usage\r')
                sent, text = True, ''
        return parse(text, int(time.time() * 1000)) if sent else None
    finally:
        for sig in (signal.SIGTERM, signal.SIGKILL):  # only the process group this script started
            try:
                os.killpg(child.pid, sig)
                child.wait(timeout=.5)
            except (ProcessLookupError, subprocess.TimeoutExpired, OSError):
                pass
        os.close(master)


if __name__ == '__main__':
    try:
        print(json.dumps(read_panel()))
    except Exception as error:  # a meter that cannot be read is "unknown", never a crash
        print('null')
        print('Claude usage unavailable: ' + type(error).__name__, file=sys.stderr)
