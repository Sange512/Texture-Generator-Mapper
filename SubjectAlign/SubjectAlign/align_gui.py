# -*- coding: utf-8 -*-
"""
模型主体对齐工具 - 图形界面版
拖入/选择 白模图 + AI生成图，点一下按钮即可对齐。

运行:
    python align_gui.py
依赖:
    pip install opencv-python numpy pillow
    pip install "rembg[cpu]"   # 推荐, 抠图更准
"""
import os
import sys
import subprocess
import threading
import traceback
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

# --- 抑制 Windows 下第三方库(rembg/onnxruntime/numba 等)弹出的子进程黑窗 ---
if sys.platform == "win32":
    _OrigPopen = subprocess.Popen

    class _NoWindowPopen(_OrigPopen):
        def __init__(self, *args, **kwargs):
            si = kwargs.get("startupinfo") or subprocess.STARTUPINFO()
            si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            kwargs["startupinfo"] = si
            kwargs["creationflags"] = kwargs.get("creationflags", 0) | subprocess.CREATE_NO_WINDOW
            super().__init__(*args, **kwargs)

    subprocess.Popen = _NoWindowPopen

import cv2
from PIL import Image, ImageTk

from align_subject import align_images, imwrite_unicode


def _close_splash():
    """若由 PyInstaller --splash 打包, 启动完成后关闭启动画面。"""
    try:
        import pyi_splash  # 仅打包后存在
        pyi_splash.close()
    except Exception:
        pass

# 可选: 拖拽支持(装了 tkinterdnd2 才启用)
try:
    from tkinterdnd2 import DND_FILES, TkinterDnD
    HAS_DND = True
except Exception:
    HAS_DND = False

PREVIEW_W = 220   # 预览最大宽度
PREVIEW_H = 190   # 预览最大高度(限制竖图, 保证 3 排能放下)


def _checkerboard(h, w, tile=12):
    """生成棋盘格底(用于可视化透明区域)。返回 RGB uint8。"""
    import numpy as np
    board = np.empty((h, w, 3), np.uint8)
    ys = (np.arange(h) // tile)[:, None]
    xs = (np.arange(w) // tile)[None, :]
    board[:] = np.where(((ys + xs) % 2 == 0)[..., None], 235, 170).astype(np.uint8)
    return board


def cv2_to_tk(img, max_w, max_h=None):
    """OpenCV 图 -> Tk 可显示的缩略图(按最大宽/高等比缩放)。
    3通道: 按 BGR 显示; 4通道(BGRA): 按 alpha 合成到棋盘格上, 直观显示透明背景。"""
    import numpy as np
    h, w = img.shape[:2]
    scale = min(1.0, max_w / w)
    if max_h:
        scale = min(scale, max_h / h)
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    img = cv2.resize(img, (nw, nh))
    if img.ndim == 3 and img.shape[2] == 4:
        bgr = img[:, :, :3].astype(np.float32)
        a = (img[:, :, 3:4].astype(np.float32)) / 255.0
        board = _checkerboard(nh, nw).astype(np.float32)[:, :, ::-1]  # RGB->BGR 以匹配 bgr
        comp = (bgr * a + board * (1 - a)).astype(np.uint8)
        rgb = cv2.cvtColor(comp, cv2.COLOR_BGR2RGB)
    else:
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    return ImageTk.PhotoImage(Image.fromarray(rgb))


def imread_unicode(path):
    import numpy as np
    data = np.fromfile(path, dtype=np.uint8)
    return cv2.imdecode(data, cv2.IMREAD_COLOR) if data.size else None


class AlignApp:
    def __init__(self, root):
        self.root = root
        root.title("模型主体对齐工具")
        root.geometry("820x940")
        root.minsize(720, 640)

        self.ref_path = tk.StringVar()
        self.mov_path = tk.StringVar()
        self.opt_ecc = tk.BooleanVar(value=True)
        self.opt_hires = tk.BooleanVar(value=True)
        self.opt_refres = tk.BooleanVar(value=True)   # 成品分辨率=白模图分辨率
        self._thumbs = {}          # 保持各预览图引用, 防止被GC回收
        self._dl_buttons = []      # 结果图的“下载”按钮集合
        self._last_result = None   # 最近一次对齐结果(内存), 供“下载”按钮使用

        self._build_ui()

    # ---------- UI ----------
    def _build_ui(self):
        pad = dict(padx=8, pady=4)

        top = ttk.Frame(self.root)
        top.pack(fill="x", **pad)

        # 白模图行
        self._file_row(top, "白模图 (参考):", self.ref_path, self._pick_ref, 0)
        # AI图行
        self._file_row(top, "AI生成图 (待对齐):", self.mov_path, self._pick_mov, 1)

        # 预览区: 3 排 x 2 列
        prev = ttk.Frame(self.root)
        prev.pack(fill="x", **pad)
        # 第一排: 输入图(无下载)
        self.ref_canvas = self._img_box(prev, "白模图", 0, 0)
        self.mov_canvas = self._img_box(prev, "AI生成贴图", 0, 1)
        # 第二排: 遮罩 / 对齐叠加预览(各带下载)
        self.mask_canvas = self._img_box(prev, "遮罩", 1, 0, dl_key="mask", dl_name="mask.png")
        self.res_canvas = self._img_box(prev, "对齐叠加预览", 1, 1, dl_key="overlay", dl_name="overlay.png")
        # 第三排: 最终对齐后图 / 去背景图(各带下载)
        self.aligned_canvas = self._img_box(prev, "最终对齐后图", 2, 0, dl_key="aligned", dl_name="aligned.png")
        self.final_canvas = self._img_box(prev, "去背景图", 2, 1, dl_key="aligned_nobg", dl_name="aligned_nobg.png")

        # 选项
        opt = ttk.LabelFrame(self.root, text="选项")
        opt.pack(fill="x", **pad)
        ttk.Checkbutton(opt, text="精对齐(ECC, 允许微旋转)", variable=self.opt_ecc).pack(side="left", padx=10, pady=6)
        ttk.Checkbutton(opt, text="高分辨率(保留AI贴图细节)", variable=self.opt_hires).pack(side="left", padx=10)
        ttk.Checkbutton(opt, text="输出用白模图分辨率", variable=self.opt_refres).pack(side="left", padx=10)

        # 运行按钮 + 进度
        run = ttk.Frame(self.root)
        run.pack(fill="x", **pad)
        self.run_btn = ttk.Button(run, text="开始对齐", command=self._on_run)
        self.run_btn.pack(side="left", padx=8)
        self.progress = ttk.Progressbar(run, mode="indeterminate", length=200)
        self.progress.pack(side="left", padx=8)

        # 结果文本
        self.result_lbl = ttk.Label(self.root, text="请选择两张图片后点击「开始对齐」",
                                    foreground="#555", justify="left")
        self.result_lbl.pack(fill="x", padx=12, pady=4)

        if not HAS_DND:
            ttk.Label(self.root, text="提示: pip install tkinterdnd2 可启用拖拽图片",
                      foreground="#999").pack(side="bottom", pady=2)

    def _file_row(self, parent, label, var, cmd, row):
        ttk.Label(parent, text=label, width=16).grid(row=row, column=0, sticky="w", pady=3)
        entry = ttk.Entry(parent, textvariable=var, width=70)
        entry.grid(row=row, column=1, sticky="we", padx=4)
        ttk.Button(parent, text="浏览...", command=cmd).grid(row=row, column=2, padx=4)
        parent.columnconfigure(1, weight=1)
        if HAS_DND:
            entry.drop_target_register(DND_FILES)
            entry.dnd_bind("<<Drop>>", lambda e, v=var: self._on_drop(e, v))

    def _img_box(self, parent, title, r, c, dl_key=None, dl_name=None):
        """一个预览单元。dl_key 非空时在图下方加一个「下载」按钮(初始禁用)。返回图像 Label。"""
        frame = ttk.LabelFrame(parent, text=title)
        frame.grid(row=r, column=c, padx=6, pady=4, sticky="n")
        canvas = ttk.Label(frame, text="(无)", width=28, anchor="center")
        canvas.pack(padx=4, pady=4, ipady=28)
        if dl_key:
            btn = ttk.Button(frame, text="下载", state="disabled",
                             command=lambda: self._download_one(dl_key, dl_name))
            btn.pack(pady=(0, 6))
            self._dl_buttons.append(btn)
        return canvas

    # ---------- 事件 ----------
    def _on_drop(self, event, var):
        path = event.data.strip("{}")
        var.set(path)
        self._refresh_preview()

    def _pick_ref(self):
        p = filedialog.askopenfilename(title="选择白模图",
                                       filetypes=[("图片", "*.png *.jpg *.jpeg *.webp *.bmp"), ("全部", "*.*")])
        if p:
            self.ref_path.set(p)
            self._refresh_preview()

    def _pick_mov(self):
        p = filedialog.askopenfilename(title="选择AI生成图",
                                       filetypes=[("图片", "*.png *.jpg *.jpeg *.webp *.bmp"), ("全部", "*.*")])
        if p:
            self.mov_path.set(p)
            self._refresh_preview()

    def _refresh_preview(self):
        if self.ref_path.get() and os.path.exists(self.ref_path.get()):
            img = imread_unicode(self.ref_path.get())
            if img is not None:
                self._show(self.ref_canvas, "ref", img)
        if self.mov_path.get() and os.path.exists(self.mov_path.get()):
            img = imread_unicode(self.mov_path.get())
            if img is not None:
                self._show(self.mov_canvas, "mov", img)

    def _show(self, canvas, key, img):
        """在指定 Label 上显示一张 OpenCV 图, 并保留引用防止被回收。"""
        thumb = cv2_to_tk(img, PREVIEW_W, PREVIEW_H)
        self._thumbs[key] = thumb
        canvas.config(image=thumb, text="")

    def _on_run(self):
        ref, mov = self.ref_path.get().strip(), self.mov_path.get().strip()
        if not (ref and mov):
            messagebox.showwarning("提示", "请先选择白模图和AI生成图")
            return
        if not (os.path.exists(ref) and os.path.exists(mov)):
            messagebox.showerror("错误", "图片路径不存在")
            return

        self._last_result = None
        for b in self._dl_buttons:
            b.config(state="disabled")
        self.run_btn.config(state="disabled")
        self.progress.start(12)
        self.result_lbl.config(text="正在对齐, 请稍候...(首次使用rembg会下载模型)", foreground="#555")
        # 后台线程跑, 避免界面卡死
        threading.Thread(target=self._do_align, args=(ref, mov), daemon=True).start()

    def _do_align(self, ref, mov):
        try:
            # out_path=None: 只在内存中计算并预览, 不写任何文件; 保存全部交给各图下方的「下载」按钮。
            r = align_images(ref, mov, out_path=None,
                             ecc=self.opt_ecc.get(),
                             hires=self.opt_hires.get(),
                             save_debug=False,
                             remove_bg=False,
                             match_ref_res=self.opt_refres.get())
            self.root.after(0, self._on_done, r, None)
        except Exception:
            self.root.after(0, self._on_done, None, traceback.format_exc())

    def _on_done(self, r, err):
        self.progress.stop()
        self.run_btn.config(state="normal")
        if err:
            self.result_lbl.config(text="对齐失败", foreground="#c00")
            messagebox.showerror("对齐失败", err)
            return
        self._last_result = r
        # 第二、三排结果图
        if r.get("mask") is not None:
            self._show(self.mask_canvas, "mask", r["mask"])
        self._show(self.res_canvas, "overlay", r["overlay"])
        if r.get("aligned") is not None:
            self._show(self.aligned_canvas, "aligned", r["aligned"])
        if r.get("aligned_nobg") is not None:
            self._show(self.final_canvas, "aligned_nobg", r["aligned_nobg"])
        for b in self._dl_buttons:
            b.config(state="normal")
        quality = "对齐良好" if r["iou_after"] >= 0.9 else ("一般, 建议检查抠图" if r["iou_after"] >= 0.75 else "较差, 建议装rembg或换图")
        self.result_lbl.config(
            text=(f"完成 [{quality}]  |  方式 {r.get('method','-')}  |  主体缩放 {r['scale']:.3f}  |  "
                  f"AI图有效缩放 {r['eff_scale']:.3f}  |  输出尺寸 {r['out_size'][0]}x{r['out_size'][1]}\n"
                  f"重合度 IoU: 对齐前 {r['iou_before']:.3f}  ->  对齐后 {r['iou_after']:.3f}  |  "
                  f"点各图下方「下载」按钮保存需要的图"),
            foreground="#0a7d00" if r["iou_after"] >= 0.9 else "#b06a00")

    def _download_one(self, key, default_name):
        """下载单张结果图。key ∈ {mask, overlay, aligned, aligned_nobg}。"""
        r = self._last_result
        if r is None or r.get(key) is None:
            messagebox.showwarning("提示", "请先点击「开始对齐」生成结果")
            return
        png_only = (key == "aligned_nobg")   # 去背景图含透明通道, 必须存 PNG
        ft = [("PNG", "*.png")] if png_only else [("PNG", "*.png"), ("JPG", "*.jpg")]
        out = filedialog.asksaveasfilename(title="下载图片", defaultextension=".png",
                                           initialfile=default_name, filetypes=ft)
        if not out:
            return
        if png_only and not out.lower().endswith(".png"):
            out = os.path.splitext(out)[0] + ".png"
        try:
            imwrite_unicode(out, r[key])
        except Exception as e:
            messagebox.showerror("下载失败", str(e))
            return
        self.result_lbl.config(text=f"已下载: {out}", foreground="#0a7d00")


def main():
    root = TkinterDnD.Tk() if HAS_DND else tk.Tk()
    AlignApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
