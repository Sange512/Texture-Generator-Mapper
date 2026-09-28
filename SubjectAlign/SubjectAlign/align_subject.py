# -*- coding: utf-8 -*-
"""
将 AI 生成的带贴图模型图，对齐到同视角白模图。

针对“同一视角、仅颜色不同”的场景做了强化对齐：
  1) 前景剪影(mask) -> 距离变换特征(SDF)，给 ECC 提供大范围平滑梯度；
  2) 多候选粗对齐：均匀缩放 / 外接框非均匀缩放；
  3) 金字塔(多尺度) ECC 精修，模型含 仿射 与 单应(Homography)；
  4) 所有候选按 IoU(重合度) 全局择优，保证结果不劣于任一单独方案。

依赖:
    pip install opencv-python numpy pillow
    pip install rembg            # 抠图(强烈推荐)，没装会回退到 GrabCut/阈值

用法:
    python align_subject.py --ref 白模图.png --mov AI生成图.png --out aligned.png
    # --ecc 开启精对齐(金字塔ECC, 仿射+单应)   --debug 输出调试图
    # --no-bg 不额外输出去背景透明PNG(默认会输出 *_nobg.png)
"""
import argparse
import os
import cv2
import numpy as np

try:
    from rembg import remove
    from PIL import Image
    HAS_REMBG = True
except Exception:
    HAS_REMBG = False


def imread_unicode(path, flags=cv2.IMREAD_COLOR):
    """支持中文/非ASCII路径的读图。"""
    data = np.fromfile(path, dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, flags)


def imwrite_unicode(path, img):
    """支持中文/非ASCII路径的写图。"""
    ext = os.path.splitext(path)[1] or ".png"
    ok, buf = cv2.imencode(ext, img)
    if ok:
        buf.tofile(path)
    return ok


def get_mask(img_bgr, return_alpha=False):
    """返回 0/255 的前景 mask。优先 rembg，失败则回退 GrabCut。
    return_alpha=True 时额外返回 rembg 的“柔和 alpha”(0..255 uint8, 抠图 matte,
    含头发/边缘半透明), 供高质量去背景使用; rembg 不可用时该值为 None。"""
    mask = None
    soft = None
    if HAS_REMBG:
        try:
            rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
            rgba = np.array(remove(Image.fromarray(rgb)))
            soft = rgba[:, :, 3].astype(np.uint8)      # 柔和 matte
            mask = (soft > 127).astype(np.uint8) * 255
        except Exception as e:
            print(f"[warn] rembg 抠图失败({e})，回退 GrabCut")
            mask = None
            soft = None

    if mask is None or (mask > 0).sum() < 50:
        h, w = img_bgr.shape[:2]
        mask = np.zeros((h, w), np.uint8)
        rect = (int(w * 0.08), int(h * 0.08), int(w * 0.84), int(h * 0.84))
        bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
        cv2.grabCut(img_bgr, mask, rect, bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
        mask = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)

    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n > 1:
        biggest = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
        mask = (lab == biggest).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))

    if return_alpha:
        if soft is not None:
            # 只保留主体连通域附近的柔和 alpha, 去掉零散杂点; 略微膨胀以保住边缘过渡带。
            keep = cv2.dilate(mask, np.ones((7, 7), np.uint8), iterations=1)
            soft = cv2.bitwise_and(soft, keep)
        return mask, soft
    return mask


def mask_stats(mask):
    """返回 (质心cx,cy, 外接框 x,y,w,h, 面积)。"""
    ys, xs = np.where(mask > 0)
    x, y, w, h = xs.min(), ys.min(), xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
    cx, cy = xs.mean(), ys.mean()
    return cx, cy, x, y, w, h, len(xs)


def iou(a, b):
    if a.shape[:2] != b.shape[:2]:
        b = cv2.resize(b, (a.shape[1], a.shape[0]), interpolation=cv2.INTER_NEAREST)
    a, b = a > 0, b > 0
    return (a & b).sum() / max((a | b).sum(), 1)


def _to_feature(mask):
    """二值 mask -> 归一化 signed distance field(SDF)。边界内外均有平滑梯度,
    大幅提升 ECC 的收敛范围与精度。"""
    m = (mask > 0).astype(np.uint8)
    din = cv2.distanceTransform(m, cv2.DIST_L2, 3)
    dout = cv2.distanceTransform((1 - m).astype(np.uint8), cv2.DIST_L2, 3)
    sdf = din - dout
    tau = max(8.0, 0.02 * float(np.hypot(mask.shape[0], mask.shape[1])))
    return np.tanh(sdf / tau).astype(np.float32)


def _apply(img, M, size, motion, flags, border):
    """按 motion 类型应用仿射(2x3)或单应(3x3)变换。"""
    if motion == cv2.MOTION_HOMOGRAPHY:
        return cv2.warpPerspective(img, M, size, flags=flags, borderValue=border)
    return cv2.warpAffine(img, M, size, flags=flags, borderValue=border)


def _affine_uniform(ref_mask, mov_mask, scale):
    """均匀缩放 + 质心对齐, 返回 2x3 仿射矩阵。"""
    rcx, rcy, _, _, _, _, _ = mask_stats(ref_mask)
    mcx, mcy, _, _, _, _, _ = mask_stats(mov_mask)
    return np.array([
        [scale, 0, rcx - scale * mcx],
        [0, scale, rcy - scale * mcy],
    ], dtype=np.float32)


def _affine_bbox(ref_mask, mov_mask):
    """外接框非均匀缩放: 把 mov 的 bbox 精确映射到 ref 的 bbox(独立 sx/sy)。"""
    _, _, rx, ry, rw, rh, _ = mask_stats(ref_mask)
    _, _, mx, my, mw, mh, _ = mask_stats(mov_mask)
    sx = rw / mw
    sy = rh / mh
    r_bcx, r_bcy = rx + rw / 2.0, ry + rh / 2.0
    m_bcx, m_bcy = mx + mw / 2.0, my + mh / 2.0
    M = np.array([
        [sx, 0, r_bcx - sx * m_bcx],
        [0, sy, r_bcy - sy * m_bcy],
    ], dtype=np.float32)
    return M, sx, sy


def coarse_uniform(ref_mask, mov_mask):
    """均匀缩放粗对齐: 尝试 高度比/宽度比/面积比, 取 IoU 最优。返回 (2x3, scale)。"""
    _, _, _, _, rw, rh, rarea = mask_stats(ref_mask)
    _, _, _, _, mw, mh, marea = mask_stats(mov_mask)
    H, W = ref_mask.shape[:2]

    cand = []
    if mh > 0:
        cand.append(rh / mh)
    if mw > 0:
        cand.append(rw / mw)
    if marea > 0:
        cand.append((rarea / marea) ** 0.5)
    uniq = []
    for s in cand:
        if s > 0 and all(abs(s - u) > 1e-3 for u in uniq):
            uniq.append(s)
    if not uniq:
        uniq = [1.0]

    best_M, best_scale, best_iou = None, uniq[0], -1.0
    for s in uniq:
        M = _affine_uniform(ref_mask, mov_mask, s)
        score = iou(ref_mask, cv2.warpAffine(mov_mask, M, (W, H)))
        if score > best_iou:
            best_iou, best_M, best_scale = score, M, s
    return best_M, best_scale


def _ecc_pyramid(ref_feat, mov_feat, warp_init, motion, levels=4, iters=300):
    """金字塔(多尺度) ECC 精修。从粗到细逐级用上一级结果作初值, 稳健且精确。
    失败/发散的层自动跳过。"""
    h, w = ref_feat.shape[:2]
    is_h = (motion == cv2.MOTION_HOMOGRAPHY)
    warp = warp_init.astype(np.float32).copy()
    scales = []
    for i in range(levels):
        sc = 1.0 / (2 ** (levels - 1 - i))
        if min(w, h) * sc >= 48 or abs(sc - 1.0) < 1e-6:
            scales.append(sc)
    if not scales:
        scales = [1.0]
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, iters, 1e-6)
    for sc in scales:
        sw, sh = max(24, int(round(w * sc))), max(24, int(round(h * sc)))
        rf = cv2.resize(ref_feat, (sw, sh), interpolation=cv2.INTER_AREA)
        mf = cv2.resize(mov_feat, (sw, sh), interpolation=cv2.INTER_AREA)
        if is_h:
            T = np.array([[sc, 0, 0], [0, sc, 0], [0, 0, 1]], np.float32)
            Ti = np.array([[1 / sc, 0, 0], [0, 1 / sc, 0], [0, 0, 1]], np.float32)
            ws = (T @ warp @ Ti).astype(np.float32)
        else:
            ws = warp.copy()
            ws[0, 2] *= sc
            ws[1, 2] *= sc
        try:
            _, ws = cv2.findTransformECC(rf, mf, ws, motion, crit)
        except (cv2.error, TypeError):
            continue
        if not np.all(np.isfinite(ws)):
            continue
        if is_h:
            T = np.array([[sc, 0, 0], [0, sc, 0], [0, 0, 1]], np.float32)
            Ti = np.array([[1 / sc, 0, 0], [0, 1 / sc, 0], [0, 0, 1]], np.float32)
            warp = (Ti @ ws @ T).astype(np.float32)
        else:
            warp = ws.copy()
            warp[0, 2] /= sc
            warp[1, 2] /= sc
    return warp


def align_images(ref_path, mov_path, out_path=None,
                 ecc=True, hires=False, save_debug=False, remove_bg=True,
                 match_ref_res=True):
    """核心对齐函数。GUI / 命令行 共用。
    out_path 为 None 时只在内存中计算并返回结果(aligned / aligned_nobg 等), 不写任何文件,
    便于界面先预览、由“下载”按钮再落盘。
    match_ref_res=True 时: 无论是否高分辨率渲染, 最终输出统一缩放回“白模图分辨率”
    (高分辨率此时相当于超采样, 边缘更干净, 但成品尺寸=白模图)。"""
    ref_img = imread_unicode(ref_path, cv2.IMREAD_COLOR)
    mov_img = imread_unicode(mov_path, cv2.IMREAD_COLOR)
    if ref_img is None:
        raise ValueError(f"白模图读取失败: {ref_path}")
    if mov_img is None:
        raise ValueError(f"AI图读取失败: {mov_path}")
    H, W = ref_img.shape[:2]

    ref_mask = get_mask(ref_img)
    mov_mask, mov_alpha = get_mask(mov_img, return_alpha=True)  # mov_alpha: rembg 柔和 matte(可能为 None)
    ref_feat = _to_feature(ref_mask)
    mov_feat = _to_feature(mov_mask)

    def score(M, motion):
        m = _apply(mov_mask, M, (W, H), motion, cv2.INTER_NEAREST, 0)
        return float(iou(ref_mask, m))

    M_uni, s_uni = coarse_uniform(ref_mask, mov_mask)
    M_bbox, sx, sy = _affine_bbox(ref_mask, mov_mask)
    coarse_list = [
        ("均匀缩放+平移", M_uni, float(s_uni)),
        ("非均匀bbox对齐", M_bbox, float((sx + sy) / 2.0)),
    ]

    best = None  # (iou, method, M, motion, scale)

    def consider(iouv, method, M, motion, scale):
        nonlocal best
        if best is None or iouv > best[0]:
            best = (iouv, method, M, motion, scale)

    for name, Mc, sc in coarse_list:
        consider(score(Mc, cv2.MOTION_AFFINE), name, Mc, cv2.MOTION_AFFINE, sc)
        if ecc:
            Ma = _ecc_pyramid(ref_feat, mov_feat, Mc, cv2.MOTION_AFFINE)
            consider(score(Ma, cv2.MOTION_AFFINE), name + "+仿射ECC", Ma, cv2.MOTION_AFFINE, sc)
            H0 = np.vstack([Ma, [0, 0, 1]]).astype(np.float32)
            Mh = _ecc_pyramid(ref_feat, mov_feat, H0, cv2.MOTION_HOMOGRAPHY)
            consider(score(Mh, cv2.MOTION_HOMOGRAPHY), name + "+单应ECC", Mh, cv2.MOTION_HOMOGRAPHY, sc)

    _, method, M, motion, scale = best

    out_w, out_h = W, H
    eff_scale = scale
    if hires and scale < 1.0:
        # 高分辨率模式: 把整个输出画布(含参考图与已对齐结果)放大 s 倍,
        # 使 AI 图不再被下采样(有效缩放≈1.0), 从而保留贴图细节。
        # 关键: 要放大的是"输出坐标", 即 M_new = S · M (S=diag(s,s,1));
        # 之前写成 M @ diag(1/s,1/s,1) 会把主体缩到左上角、平移量不跟随, 属于错误合成。
        s = 1.0 / scale
        out_w, out_h = int(round(W * s)), int(round(H * s))
        S = np.array([[s, 0, 0], [0, s, 0], [0, 0, 1]], np.float32)
        if motion == cv2.MOTION_HOMOGRAPHY:
            M = (S @ M).astype(np.float32)
        else:
            M = (S[:2, :2] @ M).astype(np.float32)  # 2x2 @ 2x3 = 2x3, 等价于 s*M
        eff_scale = scale * s
        ref_img = cv2.resize(ref_img, (out_w, out_h), interpolation=cv2.INTER_LANCZOS4)
        ref_mask = cv2.resize(ref_mask, (out_w, out_h), interpolation=cv2.INTER_NEAREST)

    aligned = _apply(mov_img, M, (out_w, out_h), motion, cv2.INTER_LANCZOS4, (255, 255, 255))
    aligned_mask = _apply(mov_mask, M, (out_w, out_h), motion, cv2.INTER_NEAREST, 0)

    iou_before = float(iou(ref_mask, mov_mask))
    iou_after = float(iou(ref_mask, aligned_mask))

    overlay = ref_img.copy()
    sel = aligned_mask > 0
    overlay[sel] = (0.5 * overlay[sel] + 0.5 * aligned[sel]).astype(np.uint8)

    # 去背景 alpha: 优先用 rembg 的柔和 matte(边缘平滑、保留头发细节), 用同一变换 warp;
    # 无 rembg 时回退到二值对齐 mask 的轻度羽化。
    if mov_alpha is not None:
        alpha = _apply(mov_alpha, M, (out_w, out_h), motion, cv2.INTER_LINEAR, 0)
    else:
        alpha = cv2.GaussianBlur(aligned_mask, (3, 3), 0)

    # 保持成品分辨率 = 白模图分辨率: 若渲染尺寸比白模大(高分辨率超采样), 缩回 (W,H)。
    # 下采样用 INTER_AREA 抗锯齿最好; alpha 同样处理以保留柔和边缘。
    if match_ref_res and (out_w, out_h) != (W, H):
        aligned = cv2.resize(aligned, (W, H), interpolation=cv2.INTER_AREA)
        alpha = cv2.resize(alpha, (W, H), interpolation=cv2.INTER_AREA)
        overlay = cv2.resize(overlay, (W, H), interpolation=cv2.INTER_AREA)
        out_w, out_h = W, H

    b, g, r = cv2.split(aligned)
    aligned_nobg = cv2.merge([b, g, r, alpha])
    # 遮罩(可显示/可下载): 对齐后主体的 alpha, 转成 3 通道灰度图(白=前景)
    mask_vis = cv2.cvtColor(alpha, cv2.COLOR_GRAY2BGR)

    if out_path:
        imwrite_unicode(out_path, aligned)
    nobg_path = None
    if remove_bg and out_path:
        base = os.path.splitext(out_path)[0]
        nobg_path = base + "_nobg.png"
        imwrite_unicode(nobg_path, aligned_nobg)

    if save_debug and out_path:
        base = os.path.splitext(out_path)[0]
        imwrite_unicode(base + "_refmask.png", ref_mask)
        imwrite_unicode(base + "_movmask.png", mov_mask)
        imwrite_unicode(base + "_overlay.png", overlay)

    return {
        "scale": float(scale),
        "eff_scale": float(eff_scale),
        "method": method,
        "out_size": (out_w, out_h),
        "iou_before": iou_before,
        "iou_after": iou_after,
        "out_path": out_path,
        "overlay": overlay,
        "mask": mask_vis,
        "aligned": aligned,
        "aligned_nobg": aligned_nobg,
        "nobg_path": nobg_path,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, help="白模图(参考/目标坐标系)")
    ap.add_argument("--mov", required=True, help="AI生成图(待对齐)")
    ap.add_argument("--out", default="aligned.png")
    ap.add_argument("--ecc", action="store_true", help="开启金字塔ECC精对齐(仿射+单应)")
    ap.add_argument("--hires", action="store_true",
                    help="高分辨率模式: 画布放大到AI图像素密度, 不压缩AI贴图细节")
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--no-bg", dest="no_bg", action="store_true",
                    help="不输出去背景透明PNG(默认会额外输出 *_nobg.png)")
    ap.add_argument("--full-res", dest="full_res", action="store_true",
                    help="保留高分辨率渲染尺寸(默认成品缩放回白模图分辨率)")
    args = ap.parse_args()

    r = align_images(args.ref, args.mov, args.out,
                     ecc=args.ecc, hires=args.hires, save_debug=args.debug,
                     remove_bg=not args.no_bg, match_ref_res=not args.full_res)
    print(f"[OK] 主体缩放 {r['scale']:.3f} | AI图有效缩放 {r['eff_scale']:.3f} | "
          f"方式 {r['method']} | 输出 {r['out_size'][0]}x{r['out_size'][1]} -> {r['out_path']}")
    print(f"[IoU] 对齐前 {r['iou_before']:.3f} -> 对齐后 {r['iou_after']:.3f}")
    if r['nobg_path']:
        print(f"[NoBG] 去背景透明图 -> {r['nobg_path']}")


if __name__ == "__main__":
    main()
