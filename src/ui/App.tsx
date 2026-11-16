import { useEffect } from 'react';
import { Hud } from './Hud';
import { CreateWorld, MainMenu, Progress } from './Menu';
import { useUi } from './store';
import './ui.css';

export function App() {
  const screen = useUi((s) => s.screen);
  const fatal = useUi((s) => s.fatal);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const state = useUi.getState();
      if (e.code === 'KeyH' && state.screen === 'world') useUi.setState({ hudHidden: !state.hudHidden });
      if (e.code === 'F3') {
        e.preventDefault();
        useUi.setState({ debugOpen: !state.debugOpen });
      }
      if (e.code === 'Space' && state.screen === 'world') {
        e.preventDefault();
        state.dispatch({ type: 'setSpeed', speed: state.speed === 0 ? 1 : 0 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (fatal) {
    return (
      <div className="wb-panel wb-center" data-testid="fatal">
        <div className="wb-title">Не удалось запустить WORLDBOUND</div>
        <div>{fatal}</div>
      </div>
    );
  }
  switch (screen) {
    case 'menu':
      return <MainMenu />;
    case 'create':
      return <CreateWorld />;
    case 'progress':
      return <Progress />;
    case 'world':
      return <Hud />;
  }
}
