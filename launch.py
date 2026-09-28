"""Start the local bridge in the background and open its page."""
from pathlib import Path
import os
import subprocess
import sys
import time
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get('PORT', '8765'))
URL = f'http://127.0.0.1:{PORT}'

def ready():
    try:
        with urllib.request.urlopen(URL, timeout=2) as response:
            return b'Bake Studio' in response.read(2000)
    except OSError:
        return False

if not ready():
    try:
        import requests
        from PIL import Image
    except ImportError:
        print('Missing dependencies. Run: python -m pip install -r requirements.txt')
        sys.exit(1)
    with (ROOT / 'server.local.log').open('a', encoding='utf-8') as log:
        process = subprocess.Popen([sys.executable, str(ROOT / 'server.py')], cwd=ROOT,
            stdout=log, stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    for _ in range(30):
        if ready(): break
        if process.poll() is not None:
            print('Server failed to start. See server.local.log')
            sys.exit(1)
        time.sleep(0.3)
    else:
        print('Server did not become ready. See server.local.log')
        sys.exit(1)
webbrowser.open(URL)
print(f'Bake Studio: {URL}')
