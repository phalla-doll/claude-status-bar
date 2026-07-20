import Cocoa

// Renders a full-color crab frame as an adaptive TEMPLATE image for System color mode.
// A template (isTemplate=true) is drawn by macOS in one uniform system color (black on a light
// menu bar, white on a dark one, automatically), so only the alpha channel can carry detail.
// To keep the sprite's depth, brightness is mapped to opacity: the bright body stays solid, the
// darker legs/shading fade to partial (gray) ink, and the darkest pixels (eyes, outlines) drop out
// entirely as transparent holes, the same negative-space eyes as the original. Source coverage
// (anti-aliased edges) is preserved by modulating the original alpha. Run once per frame at load
// and cached by the caller, so it costs nothing during the animation.
func adaptiveCrabFrame(_ src: NSImage) -> NSImage {
    guard let tiff = src.tiffRepresentation,
          let bmp = NSBitmapImageRep(data: tiff),
          let cgSrc = bmp.cgImage else { return src }
    let pw = bmp.pixelsWide, ph = bmp.pixelsHigh
    let cs = CGColorSpaceCreateDeviceRGB()
    let bi = CGImageAlphaInfo.premultipliedLast.rawValue
    guard let ctx = CGContext(data: nil, width: pw, height: ph, bitsPerComponent: 8,
                              bytesPerRow: pw * 4, space: cs, bitmapInfo: bi) else { return src }
    ctx.draw(cgSrc, in: CGRect(x: 0, y: 0, width: pw, height: ph))
    guard let raw = ctx.data else { return src }
    let px = raw.bindMemory(to: UInt8.self, capacity: pw * ph * 4)

    // Tuned by eye. Brightness -> opacity: pixels below `darkCut` become transparent holes (eyes);
    // brightness from darkCut up to `bodyLevel` ramps gray -> solid, so the body reads solid and the
    // legs stay gray. `gamma` shapes that ramp (>1 keeps more of it gray, <1 fills toward solid).
    // Measured from the sprite: eyes/outlines lum <= 0.15, darker legs ~0.45, body ~0.57. So darkCut
    // sits above the eyes (they punch through as holes) and below the legs (they stay gray), and
    // bodyLevel sits at the body brightness (it goes solid). gamma deepens the legs' gray.
    let darkCut = 0.30, bodyLevel = 0.54, gamma = 1.3
    for i in 0..<(pw * ph) {
        let off = i * 4
        let rawA = px[off + 3]
        guard rawA > 0 else { continue }                 // background stays transparent
        let af = Double(rawA) / 255
        let r = Double(px[off])     / (255 * af)
        let g = Double(px[off + 1]) / (255 * af)
        let b = Double(px[off + 2]) / (255 * af)
        let lum = 0.299 * r + 0.587 * g + 0.114 * b
        px[off] = 0; px[off + 1] = 0; px[off + 2] = 0    // template ink is black
        if lum < darkCut {
            px[off + 3] = 0                              // eyes / outlines: transparent holes
        } else {
            let t = min(1, (lum - darkCut) / (bodyLevel - darkCut))
            px[off + 3] = UInt8(max(0, min(255, Double(rawA) * pow(t, gamma))))
        }
    }
    guard let outCG = ctx.makeImage() else { return src }
    let img = NSImage(cgImage: outCG, size: src.size)
    img.isTemplate = true
    return img
}

// Builds the "waiting for approval" claw-wave cycle from the baked standing frame (crab frame 0).
// The sprite is flat blocks of one body color, so the raised arm is drawn as plain rects sampled
// from the body — no extra source art needed. Coordinates assume the baked frame layout
// (51x36, cropped to the walk cycle's common bounding box): the right arm is the horizontal
// stub at rows 10-19 / cols 43-50, and rows 0-1 above the head are free for the raised claw.
// The canvas gains 4px on the right so the mid pose can lean outward.
// Returns 4 frames — down, mid, up, mid — meant to ping-pong at a low fps.
func wavingCrabFrames(from base: NSImage) -> [NSImage] {
    guard let tiff = base.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
          let data = rep.bitmapData else { return [] }
    let bw = rep.pixelsWide, bh = rep.pixelsHigh
    guard bw > 43, bh > 19 else { return [] } // not the layout we know how to edit
    // Body color from a solid pixel, read raw: colorAt() mis-tags sRGB data as calibrated RGB,
    // which draws the new blocks visibly lighter than the sprite.
    let off = (bh / 2) * rep.bytesPerRow + (bw / 2) * (rep.bitsPerPixel / 8)
    let body = NSColor(srgbRed: CGFloat(data[off]) / 255, green: CGFloat(data[off + 1]) / 255,
                       blue: CGFloat(data[off + 2]) / 255, alpha: 1)
    let W = bw + 4, H = bh

    // Rects in top-origin pixel coords (matching how the sprite reads), converted for drawing.
    func R(_ x: Int, _ y: Int, _ w: Int, _ h: Int) -> NSRect {
        NSRect(x: CGFloat(x), y: CGFloat(H - y - h), width: CGFloat(w), height: CGFloat(h))
    }
    // Draw into an explicit bitmap context: a drawingHandler-backed NSImage reports pixelsWide=0,
    // which would defeat crabIcon's aspect math (the icon would render squashed to 18x18).
    func pose(arm blocks: [NSRect], notch holes: [NSRect]) -> NSImage? {
        let cs = CGColorSpaceCreateDeviceRGB()
        let bi = CGImageAlphaInfo.premultipliedLast.rawValue
        guard let cg = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8,
                                 bytesPerRow: W * 4, space: cs, bitmapInfo: bi) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: false)
        NSGraphicsContext.current?.imageInterpolation = .none
        base.draw(in: NSRect(x: 0, y: 0, width: CGFloat(bw), height: CGFloat(bh)),
                  from: .zero, operation: .sourceOver, fraction: 1.0)
        if !blocks.isEmpty { cg.clear(R(43, 10, 8, 10)) } // detach the right arm stub
        body.setFill()
        for b in blocks { b.fill() }
        for h in holes { cg.clear(h) }
        NSGraphicsContext.restoreGraphicsState()
        guard let out = cg.makeImage() else { return nil }
        // Wrap in an explicit bitmap rep: NSImage(cgImage:size:) makes a proxy rep that reports
        // pixel dimensions at screen scale, which would skew anything reading pixelsWide.
        let bmp = NSBitmapImageRep(cgImage: out)
        bmp.size = NSSize(width: W, height: H)
        let img = NSImage(size: bmp.size)
        img.addRepresentation(bmp)
        return img
    }

    guard let down = pose(arm: [], notch: []),
          let mid = pose(arm: [
              R(42, 10, 6, 6),   // shoulder, overlapping the body edge
              R(46, 5, 6, 7),    // forearm, leaning out
              R(48, 1, 7, 6),    // claw
          ], notch: [R(51, 1, 2, 2)]),
          let up = pose(arm: [
              R(42, 9, 6, 7),
              R(44, 3, 6, 8),
              R(43, 0, 8, 5),    // claw over the head line
          ], notch: [R(46, 0, 2, 2)])
    else { return [] }
    return [down, mid, up, mid]
}
