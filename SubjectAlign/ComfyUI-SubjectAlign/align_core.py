# -*- coding: utf-8 -*-
"""
主体对齐核心(内存版, 自包含) —— 供 ComfyUI 节点调用。
输入/输出均为 numpy BGR 图, 不涉及文件读写。

算法与桌面工具一致:
  1) 前景剪影(mask) -> 距离变换特征(SDF), 给 ECC 提供大范围平滑梯度;
  2) 多候选粗对齐: 均匀缩放 / 外接框非均匀缩放;
  3) 金字塔(多尺度) ECC 精修, 含 仿射 与 单应(Homography);
  4) 所有候选按 IoU(重合度) 全局择优。

依赖:
  pip install opencv-python numpy pillow
  pip install rembg          # 抠图(强烈推荐); 没装则回退 GrabCut/阈值
"""
import cv2
import numpy as np

try:
    from rembg import remove
    from PIL import Image
    HAS_REMBG = True
except Exception:
    HAS_REMBG = False


def get_mask(img_bgr, return_alpha=False):
    """返回 0/255 的前景 mask。优先 rembg, 失败则回退 GrabCut。
    return_alpha=True 时额外返回 rembg 的柔和 alpha(0..255 uint8, 抠图 matte); 无则为 None。"""
    mask = None
    soft = None
    if HAS_REMBG:
        try:
            rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
            rgba = np.array(remove(Image.fromarray(rgb)))
            soft = rgba[:, :, 3].astype(np.uint8)
            mask = (soft > 127).astype(np.uint8) * 255
        except Exception as e:
            print(f"[SubjectAlign][warn] rembg 抠图失败({e}), 回退 GrabCut")
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
            keep = cv2.dilate(mask, np.ones((7, 7), np.uint8), iterations=1)
            soft = cv2.bitwise_and(soft, keep)
        return mask, soft
    return mask


def mask_stats(mask):
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
    m = (mask > 0).astype(np.uint8)
    din = cv2.distanceTransform(m, cv2.DIST_L2, 3)
    dout = cv2.distanceTransform((1 - m).astype(np.uint8), cv2.DIST_L2, 3)
    sdf = din - dout
    tau = max(8.0, 0.02 * float(np.hypot(mask.shape[0], mask.shape[1])))
    return np.tanh(sdf / tau).astype(np.float32)


def _apply(img, M, size, motion, flags, border):
    if motion == cv2.MOTION_HOMOGRAPHY:
        return cv2.warpPerspective(img, M, size, flags=flags, borderValue=border)
    return cv2.warpAffine(img, M, size, flags=flags, borderValue=border)


def _affine_uniform(ref_mask, mov_mask, scale):
    rcx, rcy, _, _, _, _, _ = mask_stats(ref_mask)
    mcx, mcy, _, _, _, _, _ = mask_stats(mov_mask)
    return np.array([
        [scale, 0, rcx - scale * mcx],
        [0, scale, rcy - scale * mcy],
    ], dtype=np.float32)


def _affine_bbox(ref_mask, mov_mask):
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


def align_core(ref_img, mov_img, ecc=True, hires=True, match_ref_res=True):
    """内存版对齐核心。
    输入: ref_img/mov_img 为 numpy BGR (uint8)。
    返回 dict:
        aligned      : BGR uint8, 对齐后的AI图(白底)
        overlay      : BGR uint8, 白模与对齐结果的叠加预览
        alpha        : uint8 单通道, 对齐后主体的柔和遮罩(0..255)
        scale/eff_scale/method/iou_before/iou_after/out_size
    """
    if ref_img is None or mov_img is None:
        raise ValueError("ref_img / mov_img 不能为空")
    H, W = ref_img.shape[:2]

    ref_mask = get_mask(ref_img)
    mov_mask, mov_alpha = get_mask(mov_img, return_alpha=True)
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

    best = None

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
        s = 1.0 / scale
        out_w, out_h = int(round(W * s)), int(round(H * s))
        S = np.array([[s, 0, 0], [0, s, 0], [0, 0, 1]], np.float32)
        if motion == cv2.MOTION_HOMOGRAPHY:
            M = (S @ M).astype(np.float32)
        else:
            M = (S[:2, :2] @ M).astype(np.float32)
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

    if mov_alpha is not None:
        alpha = _apply(mov_alpha, M, (out_w, out_h), motion, cv2.INTER_LINEAR, 0)
    else:
        alpha = cv2.GaussianBlur(aligned_mask, (3, 3), 0)

    if match_ref_res and (out_w, out_h) != (W, H):
        aligned = cv2.resize(aligned, (W, H), interpolation=cv2.INTER_AREA)
        alpha = cv2.resize(alpha, (W, H), interpolation=cv2.INTER_AREA)
        overlay = cv2.resize(overlay, (W, H), interpolation=cv2.INTER_AREA)
        out_w, out_h = W, H

    if alpha.ndim == 3:
        alpha = alpha[:, :, 0]

    return {
        "aligned": aligned,
        "overlay": overlay,
        "alpha": alpha,
        "scale": float(scale),
        "eff_scale": float(eff_scale),
        "method": method,
        "iou_before": iou_before,
        "iou_after": iou_after,
        "out_size": (out_w, out_h),
    }
