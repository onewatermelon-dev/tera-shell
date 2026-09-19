import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from "react";
import MagicRings from "@/terminal/components/MagicRings";

export type AppLoadingHandle = {
  finish: () => void;
};

type Props = {
  onFinished: () => void;
};

// 应用启动加载层：WebView 初始化完成前渲染 MagicRings 动画遮住白屏，
// 父组件在应用就绪后调用 finish() 触发淡出并销毁自身。
const AppLoading = forwardRef<
  AppLoadingHandle,
  Props
>(function AppLoading({ onFinished }, ref) {
  const [fading, setFading] = useState(false);
  const finishedRef = useRef(false);

  useImperativeHandle(ref, () => ({
    finish() {
      if (finishedRef.current) return;
      finishedRef.current = true;
      setFading(true);
    }
  }));

  useEffect(() => {
    if (!fading) return;
    const id = setTimeout(onFinished, 500);
    return () => clearTimeout(id);
  }, [fading, onFinished]);

  return (
    <div
      className={`app-loading${fading ? " fading" : ""}`}
      role="status"
      aria-label="正在加载"
    >
      <div className="app-loading-rings">
        <MagicRings
          color="#fc42ff"
          colorTwo="#42fcff"
          ringCount={5}
          speed={1}
          attenuation={9}
          lineThickness={2.5}
          baseRadius={0.3}
          radiusStep={0.11}
          scaleRate={0.12}
          opacity={0.95}
          noiseAmount={0.15}
        />
      </div>
    </div>
  );
});

export default AppLoading;
