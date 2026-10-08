#!/usr/bin/env python3
"""通过 GitHub Git Data API 把 dist/ 部署到 gh-pages 分支（绕过 git:// 隧道被代理拦截的问题）。"""
import os, sys, json, base64, urllib.request, urllib.error

TOKEN = open('/tmp/gh_token.txt').read().strip()
REPO = 'jiangyufan/feishu-literature-reader'
BRANCH = 'gh-pages'
DIST = os.path.join(os.path.dirname(__file__), 'dist')
API = f'https://api.github.com/repos/{REPO}'

def api(method, path, data=None):
    url = API + path
    req = urllib.request.Request(url, method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'Authorization': f'Bearer {TOKEN}',
                 'Accept': 'application/vnd.github+json',
                 'Content-Type': 'application/json',
                 'User-Agent': 'deploy-script'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f'HTTP {e.code} {method} {path}: {body[:300]}', file=sys.stderr)
        raise

# 1. 拿到当前 gh-pages 的 base tree
ref = api('GET', f'/git/ref/heads/{BRANCH}')
base_commit_sha = ref['object']['sha']
base_commit = api('GET', f'/git/commits/{base_commit_sha}')
base_tree_sha = base_commit['tree']['sha']

# 2. 为 dist 下每个文件创建 blob（排除 .git 等内部目录）
blobs = []
for root, dirs, files in os.walk(DIST):
    dirs[:] = [d for d in dirs if d != '.git']
    for fn in files:
        full = os.path.join(root, fn)
        rel = os.path.relpath(full, DIST).replace(os.sep, '/')
        with open(full, 'rb') as f:
            content = f.read()
        b64 = base64.b64encode(content).decode()
        blob = api('POST', '/git/blobs', {'content': b64, 'encoding': 'base64'})
        blobs.append({'path': rel, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
        print('blob:', rel, len(content), 'bytes')

# 3. 创建 tree（整树替换，不叠加旧 hash 资源）
new_tree = api('POST', '/git/trees', {'tree': blobs})

# 4. 创建 commit
msg = 'deploy: v6.18 相关文献伪造/营销号/拒答拦截强化；References块切区；专著相关文献清空；字段串味清理；去重；CACHE_VER=9'
new_commit = api('POST', '/git/commits', {
    'message': msg, 'tree': new_tree['sha'], 'parents': [base_commit_sha]})

# 5. 更新 ref
api('PATCH', f'/git/refs/heads/{BRANCH}', {'sha': new_commit['sha']})
print('DEPLOYED commit:', new_commit['sha'])
print('url:', f'https://jiangyufan.github.io/{REPO.split("/")[1]}/')
