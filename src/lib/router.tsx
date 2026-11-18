import * as React from 'react';

/**
 * Tiny history router (about 1 KB). The app has seven screens, so a full routing library
 * would only slow down the first load on a phone.
 */

interface NavigateOptions {
  replace?: boolean;
}

interface RouterValue {
  path: string;
  navigate: (to: string, options?: NavigateOptions) => void;
}

const RouterContext = React.createContext<RouterValue>({ path: '/', navigate: () => undefined });
const ParamsContext = React.createContext<Record<string, string>>({});

export function Router({ children }: { children: React.ReactNode }) {
  const [path, setPath] = React.useState(() => window.location.pathname);

  React.useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = React.useCallback((to: string, options?: NavigateOptions) => {
    if (options?.replace) window.history.replaceState(null, '', to);
    else window.history.pushState(null, '', to);
    setPath(window.location.pathname);
    window.scrollTo(0, 0);
    // Lets a waiting app update apply when the user is back on the upload screen.
    window.dispatchEvent(new Event('qp:navigate'));
  }, []);

  const value = React.useMemo(() => ({ path, navigate }), [path, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useNavigate(): RouterValue['navigate'] {
  return React.useContext(RouterContext).navigate;
}

export function usePath(): string {
  return React.useContext(RouterContext).path;
}

export function useParams(): Record<string, string | undefined> {
  return React.useContext(ParamsContext);
}

/** Matches "/review/:id" style patterns. Returns the params, or null when the path does not match. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/').filter(Boolean);
  const have = path.split('/').filter(Boolean);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) {
      try {
        params[want[i].slice(1)] = decodeURIComponent(have[i]);
      } catch {
        return null;
      }
    } else if (want[i] !== have[i]) return null;
  }
  return params;
}

export interface RouteDef {
  path: string;
  element: React.ReactNode;
}

/** Renders the first matching route; unknown addresses go back to the home screen. */
export function Routes({ routes }: { routes: RouteDef[] }) {
  const { path, navigate } = React.useContext(RouterContext);
  let match: { route: RouteDef; params: Record<string, string> } | null = null;
  for (const route of routes) {
    const params = matchPath(route.path, path);
    if (params) {
      match = { route, params };
      break;
    }
  }
  React.useEffect(() => {
    if (!match) navigate('/', { replace: true });
  }, [match, navigate]);
  if (!match) return null;
  // Keying by path gives every screen a fresh state when its address changes.
  return (
    <ParamsContext.Provider value={match.params}>
      <React.Fragment key={path}>{match.route.element}</React.Fragment>
    </ParamsContext.Provider>
  );
}

type LinkProps = Omit<React.ComponentProps<'a'>, 'href'> & { to: string; replace?: boolean };

export function Link({ to, replace, onClick, ...props }: LinkProps) {
  const navigate = useNavigate();
  return (
    <a
      href={to}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(to, { replace });
      }}
      {...props}
    />
  );
}
