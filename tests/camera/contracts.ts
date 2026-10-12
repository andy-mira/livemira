import type { FrameSource, FramePacket, FrameGeometry, WorkerFrameLease } from '@livemira/contracts';
import { CameraFrameSource, ReplayFrameSource, createGeometry, toFrameGeometry, createFramePacket } from '../../packages/camera/src/index.mjs';
import { prepareWorkerFrame } from '../../packages/camera/src/index.mjs';
const prepare: (frame: FramePacket, geometry: FrameGeometry | null, signal: AbortSignal) => Promise<WorkerFrameLease> = prepareWorkerFrame;
void prepare;
const sources: FrameSource[] = [new CameraFrameSource(), new ReplayFrameSource()];
const geometry: FrameGeometry = toFrameGeometry(createGeometry({ width: 1280, height: 720 }));
const packetFactory: (sample: FramePacket) => FramePacket = createFramePacket;
void sources; void geometry; void packetFactory;
