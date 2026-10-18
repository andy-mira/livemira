# @livemira/camera

Camera capture, new-frame detection, snapshots, frame clock, frame geometry, viewport gate and camera preview layer.

## Dependencies

`@livemira/contracts`

## Public API

Private workspace package, bundled into `@livemira/engine`.

- `CameraSource`: opens the camera, detects new frames (video frame callbacks, or animation frames with decoded-frame
  counts), takes snapshots (`SnapshotStrategy` list, canvas readback last), delivers owned frames with their own
  `FrameGeometry`, watches for stalls and stops when the page is hidden.
- `ViewportGate`: masks the camera region from a view change until the new view has settled, been painted and been
  confirmed by a fresh frame.
- `mountPreviewLayer`, `canvasPreviewSurface`, `videoPreviewSurface`, `previewStyle`: the preview, drawn into a canvas
  with the same transform as the frames used for recognition.
- `createGeometry`, `FrameClock`, `createOwnedImage`.
