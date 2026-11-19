#!/usr/bin/env python3
# A small stand-in for /usr/libexec/PlistBuddy, used when the Mac installer
# sandbox runs on Linux. A Mac uses the real tool. Usage:
#   tools/plist-buddy.py -c 'Print :key' file.plist
#   tools/plist-buddy.py -c 'Add :key string value' file.plist
#   tools/plist-buddy.py -c 'Delete :key' file.plist
import plistlib
import sys


def load(path):
    try:
        with open(path, 'rb') as handle:
            return plistlib.load(handle)
    except FileNotFoundError:
        return {}


def save(path, data):
    with open(path, 'wb') as handle:
        plistlib.dump(data, handle)


def segments(key):
    if not key.startswith(':'):
        sys.exit(f'bad key {key}')
    return key.split(':')[1:]


def walk(node, segs):
    cur = node
    for seg in segs:
        if isinstance(cur, list):
            cur = cur[int(seg)]
        else:
            cur = cur[seg]
    return cur


def blank(kind, value):
    if kind == 'array':
        return []
    if kind == 'dict':
        return {}
    if kind == 'string':
        return value
    if kind == 'integer':
        return int(value)
    sys.exit(f'bad type {kind}')


def show(value):
    if isinstance(value, dict):
        lines = []
        for key, item in value.items():
            lines.append(str(key))
            lines.append(show(item))
        return '\n'.join(lines)
    if isinstance(value, list):
        return '\n'.join(show(item) for item in value)
    return str(value)


def add(root, segs, kind, value):
    made = blank(kind, value)
    if segs[-1] == '':
        walk(root, segs[:-1]).append(made)
        return
    parent = walk(root, segs[:-1]) if len(segs) > 1 else root
    key = segs[-1]
    if isinstance(parent, list):
        index = int(key)
        if index != len(parent):
            sys.exit('cannot add there')
        parent.append(made)
        return
    if key in parent:
        sys.exit('already there')
    parent[key] = made


def delete(root, segs):
    parent = walk(root, segs[:-1]) if len(segs) > 1 else root
    key = segs[-1]
    if isinstance(parent, list):
        del parent[int(key)]
    else:
        del parent[key]


def run(command, path):
    data = load(path)
    op, _, rest = command.partition(' ')
    try:
        if op == 'Print':
            print(show(walk(data, segments(rest))))
            return
        if op == 'Delete':
            delete(data, segments(rest))
        elif op == 'Add':
            key, kind, value = rest.split(' ', 2) if rest.count(' ') >= 2 else (*rest.split(' ', 1), '')
            add(data, segments(key), kind, value)
        else:
            sys.exit(f'bad command {op}')
    except (KeyError, IndexError, ValueError):
        sys.exit(1)
    save(path, data)


def main():
    args = sys.argv[1:]
    commands = []
    path = None
    i = 0
    while i < len(args):
        if args[i] == '-c':
            commands.append(args[i + 1])
            i += 2
            continue
        path = args[i]
        i += 1
    if not path or not commands:
        sys.exit('usage: plist-buddy.py -c command file.plist')
    for command in commands:
        run(command, path)


if __name__ == '__main__':
    main()
