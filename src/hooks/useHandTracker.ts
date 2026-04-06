import { useEffect, useRef, useState, useCallback } from 'react';
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import type { HandLandmarkerResult } from '@mediapipe/tasks-vision';

interface UseHandTrackerOptions {
  onResults: (results: HandLandmarkerResult) => void;
}

interface ZoomRange {
  min: number;
  max: number;
  step: number;
}

export function useHandTracker({ onResults }: UseHandTrackerOptions) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const animFrameRef = useRef<number>(0);
  const lastTimestampRef = useRef<number>(-1);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoomRange, setZoomRange] = useState<ZoomRange | null>(null);

  const onResultsRef = useRef(onResults);
  onResultsRef.current = onResults;

  const startDetection = useCallback(() => {
    const video = videoRef.current;
    const landmarker = landmarkerRef.current;
    if (!video || !landmarker) return;

    const detect = () => {
      if (video.readyState >= 2) {
        const now = performance.now();
        if (now !== lastTimestampRef.current) {
          lastTimestampRef.current = now;
          const results = landmarker.detectForVideo(video, now);
          onResultsRef.current(results);
        }
      }
      animFrameRef.current = requestAnimationFrame(detect);
    };

    animFrameRef.current = requestAnimationFrame(detect);
  }, []);

  const setZoom = useCallback(async (value: number) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({
        advanced: [{ zoom: value } as MediaTrackConstraintSet],
      });
    } catch {
      // câmera não suporta zoom via constraints
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm'
        );

        const landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
        });

        if (cancelled) {
          landmarker.close();
          return;
        }

        landmarkerRef.current = landmarker;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, facingMode: 'user' },
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;

        // Tenta aplicar zoom mínimo (hardware) para FOV mais amplo
        try {
          const track = stream.getVideoTracks()[0];
          const caps = track.getCapabilities() as Record<string, unknown>;
          const zoomCap = caps['zoom'] as { min?: number; max?: number; step?: number } | undefined;
          if (zoomCap?.min !== undefined && zoomCap?.max !== undefined) {
            setZoomRange({
              min: zoomCap.min,
              max: zoomCap.max,
              step: zoomCap.step ?? 0.1,
            });
            await track.applyConstraints({
              advanced: [{ zoom: zoomCap.min } as MediaTrackConstraintSet],
            });
          }
        } catch {
          // câmera não suporta controle de zoom — ignora
        }

        const video = videoRef.current!;
        video.srcObject = stream;
        video.onloadedmetadata = () => {
          video.play();
          setReady(true);
          startDetection();
        };
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Unknown error');
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      cancelAnimationFrame(animFrameRef.current);
      landmarkerRef.current?.close();
      const video = videoRef.current;
      if (video?.srcObject) {
        (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      }
    };
  }, [startDetection]);

  return { videoRef, ready, error, zoomRange, setZoom };
}
