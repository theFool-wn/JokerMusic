#!/usr/bin/env python3
"""One release source: static/version.json. Run --check in CI, --write after a bump."""
import argparse
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    
    release = json.loads((ROOT / 'static/version.json').read_text(encoding='utf-8'))
    version, code = release['version'], release['versionCode']
    
    if not re.fullmatch(r'\d+\.\d+\.\d+', version) or type(code) is not int or not 0 < code < 2100000000:
        raise SystemExit('Invalid version.json (semantic version and positive Android versionCode required)')
    rules = {
        'pyproject.toml': [(r'(?m)^version = "[^"]+"$', f'version = "{version}"')],
        'JokerMusic_Worker.py': [(r'(?m)^(# @\s+Release Version: )[^\n]+$', rf'\g<1>{version}')],
        'static/sw.js': [(r"const VERSION = '[^']+';", f"const VERSION = '{version}';")],
        'static/index.html': [
            (r'<meta name="application-version" content="[^"]+">', f'<meta name="application-version" content="{version}">'),
            (r'/static/js/(playback|app)\.js\?v=[^"\s]+', rf'/static/js/\g<1>.js?v={version}'),
        ],
        'static/login.html': [(r'<meta name="application-version" content="[^"]+">', f'<meta name="application-version" content="{version}">')],
        'README.md': [(r'(?m)^当前版本：\*\*[^*]+\*\*', f'当前版本：**{version}**')],
    }
    
    outdated = []
    for filename, replacements in rules.items():
        path = ROOT / filename
        original = path.read_text(encoding='utf-8')
        content = original
        for pattern, replacement in replacements:
            content, count = re.subn(pattern, replacement, content)
            if count == 0:
                raise SystemExit(f'Version marker missing: {filename}: {pattern}')
        if content != original:
            outdated.append(filename)
            if args.write: path.write_text(content, encoding='utf-8', newline='\n')
    if outdated and not args.write:
        raise SystemExit('Version drift: ' + ', '.join(outdated) + '. Run python scripts/version.py --write')
    print(f'Version {version} / Android {code}: ' + ('updated ' + ', '.join(outdated) if outdated else 'consistent'))


if __name__ == '__main__':
    main()
