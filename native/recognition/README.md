# Native recognition status

No native recognition binary exists. The executable numerical baseline is the original JavaScript implementation in `packages/recognition/experimental/{features,geometry}.mjs`, consumed through the contracts adapter. A native or WebAssembly port is not implemented; the CPU compute backend can delegate to these exports without copying them.

Port requirements: preserve the descriptor seed and pattern, byte order, box2 rounding, box3 smoothing and pixel-center scaling; match feature tie-breaks and reciprocal/ratio rules; compare normalized homography reprojection and degeneracy behavior against deterministic tests. Native float32 versus JavaScript float64 tolerance needs measured agreement. A successful unrelated native preprocessing build (`native/common`) does not validate recognition geometry or descriptor parity.
