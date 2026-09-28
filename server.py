"""Local Texture Generator & Mapper bridge. Only Pillow and requests are external dependencies."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit, unquote
import base64
import io
import json
import os
import threading
import time
import uuid
import mimetypes
import requests
from PIL import Image, ImageOps, ImageDraw

ROOT = Path(__file__).resolve().parent
RUNS = ROOT / 'runs'
COMFY = os.environ.get('COMFY_URL', 'http://127.0.0.1:8188').rstrip('/')
LOCK = threading.Lock()
ACTIVE = set()
DEFAULT_PROMPT = ('Image 1 is the exact target model view. Transfer the character colors, materials and costume details '
                  'from the reference sheet in image 2 onto image 1. Preserve image 1 camera angle, silhouette, pose, '
                  'proportions, framing and background exactly. Do not copy the reference pose or add geometry. '
                  'Flat albedo colors, no cast shadows, no highlights, no ambient occlusion, no text.')

def comfy(path, **kwargs):
    response = requests.request('POST' if ('json' in kwargs or 'files' in kwargs) else 'GET',
                                COMFY + path, timeout=(10, 120), **kwargs)
    if not response.ok:
        raise ValueError(f'ComfyUI {response.status_code}: {response.text[:1800]}')
    return response.json()

def read_image(data):
    if not isinstance(data, str) or not data.startswith('data:image/'):
        raise ValueError('需要图片 Data URL')
    raw = base64.b64decode(data.split(',', 1)[1], validate=True)
    with Image.open(io.BytesIO(raw)) as img:
        if img.width * img.height > 24_000_000:
            raise ValueError('单张图片不能超过 2400 万像素')
        return ImageOps.exif_transpose(img).convert('RGBA')

def save_state(folder, **changes):
    with LOCK:
        path = folder / 'job.json'
        state = json.loads(path.read_text('utf-8')) if path.exists() else {}
        state.update(changes)
        temp = folder / 'job.tmp'
        temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), 'utf-8')
        temp.replace(path)
    return state

def reference_sheet(images):
    cols = min(3, len(images)); rows = (len(images) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * 512, rows * 536), '#eeeeee')
    draw = ImageDraw.Draw(sheet)
    for i, img in enumerate(images):
        tile = ImageOps.contain(img, (496, 496))
        x = (i % cols) * 512 + (512 - tile.width) // 2
        y = (i // cols) * 536 + 28 + (496 - tile.height) // 2
        sheet.paste(tile, (x, y), tile.getchannel('A'))
        draw.text(((i % cols) * 512 + 12, (i // cols) * 536 + 8), f'Reference {i + 1}', fill='black')
    return sheet

def build_prompt(info, capture_name, reference_name, width=None, height=None, seed=None, prompt=''):
    """Use the user's API workflow unchanged except its designated inputs and output sink."""
    graph = json.loads((ROOT / 'active_workflow_api.json').read_text('utf-8'))
    for key in ('10', '11', '89'):
        if key not in graph: raise ValueError(f'工作流缺少 {key} 号节点')
    graph['10']['inputs']['image'] = capture_name
    graph['11']['inputs']['image'] = reference_name
    if seed is not None: graph['26']['inputs']['seed'] = seed
    if prompt.strip(): graph['20']['inputs']['prompt'] += '\n' + prompt.strip()
    # RMBG 89 returns IMAGE; an output node is required for /history to expose the file.
    graph['900'] = {'class_type': 'SaveImage', 'inputs': {
        'images': ['89', 0], 'filename_prefix': 'Texture Generator & Mapper/final_89'}}
    for key, node in graph.items():
        kind = node['class_type']
        if kind not in info: raise ValueError(f'缺少节点：{kind}（{key} 号）')
        schema = info[kind].get('input', {})
        fields = {**schema.get('required', {}), **schema.get('optional', {})}
        for field, value in node['inputs'].items():
            if field == 'image' and kind == 'LoadImage': continue
            spec = fields.get(field)
            if spec and isinstance(spec[0], list) and not isinstance(value, list) and value not in spec[0]:
                raise ValueError(f'{key} 号 {kind} 的 {field} 不可用：{value}')
    return graph

def upload(path):
    with path.open('rb') as stream:
        result = comfy('/upload/image', files={'image': (path.name, stream, 'image/png')},
                       data={'type': 'input', 'overwrite': 'false'})
    return '/'.join(p for p in (result.get('subfolder'), result['name']) if p)

def run_job(folder, payload):
    try:
        capture = read_image(payload['capture'])
        refs = [read_image(data) for data in payload['references']]
        capture.save(folder / 'capture.png')
        # The exact alpha is retained locally; ComfyUI receives a neutral opaque view.
        capture.save(folder / 'input.png')
        (refs[0] if len(refs) == 1 else reference_sheet(refs)).save(folder / 'references.png')
        size = int(payload.get('resolution', 512))
        if size not in (256, 512, 768, 1024):
            raise ValueError('不支持的生成分辨率')
        scale = size / max(capture.size)
        w, h = [max(64, round(n * scale / 16) * 16) for n in capture.size]
        seed = int(payload.get('seed', -1))
        if seed < 0: seed = int.from_bytes(os.urandom(6), 'big')
        if seed > 2**53 - 1: raise ValueError('种子超出范围')
        info = comfy('/object_info')
        # Validate all model/node dependencies before uploading or queuing.
        graph = build_prompt(info, 'input.png', 'references.png', w, h, seed,
                             str(payload.get('prompt', ''))[:4000])
        save_state(folder, status='uploading', message='正在上传截图和参考板', seed=seed, width=graph['87']['inputs']['width'], height=graph['87']['inputs']['height'], output_node='89')
        graph['10']['inputs']['image'] = upload(folder / 'input.png')
        graph['11']['inputs']['image'] = upload(folder / 'references.png')
        (folder / 'workflow_api.json').write_text(json.dumps(graph, ensure_ascii=False, indent=2), 'utf-8')
        (folder / 'camera.json').write_text(json.dumps(payload.get('camera', {}), indent=2), 'utf-8')
        result = comfy('/prompt', json={'prompt': graph, 'client_id': folder.name})
        prompt_id = result['prompt_id']
        save_state(folder, status='queued', prompt_id=prompt_id, message='已进入 ComfyUI 队列')
        started = time.monotonic()
        while time.monotonic() - started < 7200:
            history = comfy('/history/' + prompt_id).get(prompt_id)
            if history:
                status = history.get('status', {})
                if status.get('status_str') == 'error':
                    detail = next((m[1] for m in status.get('messages', []) if m[0] == 'execution_error'), {})
                    save_state(folder, error_detail={k: detail.get(k) for k in ('node_id', 'node_type', 'exception_message', 'traceback')})
                    errors = [m[1].get('exception_message', str(m[1])) for m in status.get('messages', [])
                              if m[0] in ('execution_error', 'execution_interrupted')]
                    raise ValueError('生成失败：' + ('; '.join(errors) or 'ComfyUI 任务中断'))
                images = history.get('outputs', {}).get('900', {}).get('images', [])
                if images:
                    response = requests.get(COMFY + '/view', params=images[0], timeout=120)
                    response.raise_for_status()
                    (folder / 'generated.png').write_bytes(response.content)
                    with Image.open(io.BytesIO(response.content)) as generated:
                        mapped = generated.convert('RGBA')
                    mapped.save(folder / 'projection.png')
                    save_state(folder, status='completed', message='生成完成，请检查预览后映射',
                               elapsed_seconds=round(time.monotonic() - started),
                               alignment='subject',
                               result=f'/runs/{folder.name}/projection.png',
                               raw_result=f'/runs/{folder.name}/generated.png')
                    return
                if status.get('completed'):
                    raise ValueError('工作流完成但没有输出图片')
            queue = comfy('/queue')
            running = any(item[1] == prompt_id for item in queue.get('queue_running', []))
            save_state(folder, status='running' if running else 'queued',
                       message='Qwen 正在生成；低显存设备可能耗时较长' if running else '等待 ComfyUI 执行',
                       elapsed_seconds=round(time.monotonic() - started))
            time.sleep(3)
        raise ValueError('等待超过 2 小时；任务记录已保留，请检查 ComfyUI')
    except Exception as exc:
        save_state(folder, status='failed', message=str(exc)[:2500])
    finally:
        with LOCK: ACTIVE.discard(folder.name)

class Handler(BaseHTTPRequestHandler):
    def respond(self, status, data, content_type='application/json; charset=utf-8'):
        raw = json.dumps(data, ensure_ascii=False).encode() if isinstance(data, (dict, list)) else data
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        try:
            if path == '/api/console':
                jobs = []
                for file in sorted(RUNS.glob('*/job.json'), key=lambda p: p.stat().st_mtime, reverse=True)[:5]:
                    with LOCK: state = json.loads(file.read_text('utf-8'))
                    if state.get('status') == 'failed' and state.get('prompt_id') and 'error_detail' not in state:
                        try:
                            history = comfy('/history/' + state['prompt_id']).get(state['prompt_id'], {})
                            detail = next((m[1] for m in history.get('status', {}).get('messages', []) if m[0] == 'execution_error'), {})
                            state = save_state(file.parent, error_detail={k: detail.get(k) for k in ('node_id', 'node_type', 'exception_message', 'traceback')})
                        except Exception: pass
                    if state.get('status') not in ('completed', 'failed') and state.get('id') not in ACTIVE:
                        state = dict(state, status='interrupted', message='前端服务曾重启；此记录已停止监控，未重新提交')
                    jobs.append(state)
                return self.respond(200, {'comfy_url': COMFY, 'jobs': list(reversed(jobs))})
            if path == '/api/health':
                info = comfy('/object_info')
                workflow_error = None
                try: build_prompt(info, 'probe.png', 'probe.png')
                except ValueError as exc: workflow_error = str(exc)
                stats = comfy('/system_stats')
                return self.respond(200, {'ok': True, 'comfy_url': COMFY,
                    'device': stats.get('devices', [{}])[0].get('name', ''),
                    'workflow': '你的 QwenEdit 白模上色：10 → 11 → 89',
                    'workflow_ready': workflow_error is None, 'workflow_error': workflow_error})
            if path.startswith('/api/jobs/'):
                job_id = path.rsplit('/', 1)[-1]
                if len(job_id) != 32 or any(c not in '0123456789abcdef' for c in job_id):
                    return self.respond(404, {'error': '任务不存在'})
                with LOCK:
                    state = json.loads((RUNS / job_id / 'job.json').read_text('utf-8'))
                if state['status'] not in ('completed', 'failed') and job_id not in ACTIVE:
                    state.update(status='failed', message='本地服务曾重启；请在 ComfyUI 检查已提交任务，避免重复生成')
                return self.respond(200, state)
            if path == '/api/demo':
                return self.respond(200, {'model': '/demo/model.glb', 'reference': '/demo/reference.png'})
            demos = {'/demo/model.glb': ROOT / 'testfiles' / '红发女孩.glb',
                     '/demo/reference.png': ROOT / 'testfiles' / '红发女上色.png'}
            if path in demos:
                file = demos[path]
            elif path == '/':
                file = ROOT / 'index.html'
            elif path.startswith(('/runs/', '/vendor/')) or path in ('/studio.js',):
                file = (ROOT / path.lstrip('/')).resolve()
                if not file.is_relative_to(ROOT): return self.respond(403, {'error': '禁止访问'})
            else:
                return self.respond(404, {'error': '文件不存在'})
            return self.respond(200, file.read_bytes(), mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
        except FileNotFoundError:
            self.respond(404, {'error': '文件不存在'})
        except Exception as exc:
            self.respond(503, {'ok': False, 'error': str(exc)[:2000]})

    def do_POST(self):
        if self.path != '/api/jobs': return self.respond(404, {'error': '接口不存在'})
        # No CORS; JSON-only prevents cross-origin form submissions to this local bridge.
        origin = self.headers.get('Origin')
        if origin and origin != 'http://' + self.headers.get('Host', ''):
            return self.respond(403, {'error': '仅接受本地页面请求'})
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.respond(415, {'error': '需要 application/json'})
        try:
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 50 * 1024 * 1024: raise ValueError('请求超过 50MB 或为空')
            payload = json.loads(self.rfile.read(length))
            refs = payload.get('references', [])
            if not isinstance(refs, list) or not 1 <= len(refs) <= 6:
                raise ValueError('请上传 1–6 张设计图')
            read_image(payload.get('capture'))
            for ref in refs: read_image(ref)
            with LOCK:
                if ACTIVE: return self.respond(409, {'error': '已有生成任务，请等待当前任务完成'})
                job_id = uuid.uuid4().hex
                ACTIVE.add(job_id)
            folder = RUNS / job_id
            folder.mkdir(parents=True)
            state = save_state(folder, id=job_id, status='preparing', message='准备生成', created_at=time.time())
            threading.Thread(target=run_job, args=(folder, payload), daemon=True).start()
            self.respond(202, state)
        except Exception as exc:
            self.respond(400, {'error': str(exc)})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8765'))
    print(f'Texture Generator & Mapper: http://127.0.0.1:{port} | ComfyUI: {COMFY}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
