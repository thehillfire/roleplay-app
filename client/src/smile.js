// On-device smile detection for Don't Smile. The camera frames go into MediaPipe's face model
// running in this browser tab; nothing about the video is sent anywhere. Loaded only when
// someone taps "Use my camera", so nobody else downloads the model.
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

export async function createSmileDetector() {
  const fileset = await FilesetResolver.forVisionTasks('/mediapipe');
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
  let landmarker;
  try {
    landmarker = await FaceLandmarker.createFromOptions(fileset, options('GPU'));
  } catch {
    landmarker = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
  }
  return {
    // 0 (straight face) to 1 (big grin), or null when no face is in view.
    smile(video, t) {
      const cats = landmarker.detectForVideo(video, t).faceBlendshapes?.[0]?.categories;
      if (!cats) return null;
      const score = (name) => cats.find((c) => c.categoryName === name)?.score || 0;
      return (score('mouthSmileLeft') + score('mouthSmileRight')) / 2;
    },
    close: () => landmarker.close(),
  };
}
