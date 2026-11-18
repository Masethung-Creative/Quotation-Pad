import { lazy, Suspense, useEffect, useState } from 'react';
import { LogIn, ShieldCheck } from 'lucide-react';
import { FullPageLoading, Logo } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Routes, type RouteDef } from '@/lib/router';
import { checkSession, goToLogin } from '@/lib/session';
import Home from '@/pages/Home';

// Only the upload screen is in the first download; every other screen loads on demand.
const ChooseTemplate = lazy(() => import('@/pages/ChooseTemplate'));
const Review = lazy(() => import('@/pages/Review'));
const Done = lazy(() => import('@/pages/Done'));
const Settings = lazy(() => import('@/pages/Settings'));
const Toaster = lazy(() => import('sonner').then((m) => ({ default: m.Toaster })));

const ROUTES: RouteDef[] = [
  { path: '/', element: <Home /> },
  { path: '/template/:id', element: <ChooseTemplate /> },
  { path: '/review/:id', element: <Review /> },
  { path: '/done/:id', element: <Done /> },
  { path: '/settings', element: <Settings /> },
];

function LoginAgain() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center" data-testid="login-again">
      <Logo className="size-14" />
      <h1 className="mt-5 text-2xl font-semibold">Please log in again</h1>
      <p className="mt-2 text-muted-foreground">Your login has expired. Log in with your email to keep using Quotation Pad.</p>
      <p className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0 text-success" /> Your quotations and signatures are still saved on this device.
      </p>
      <Button size="lg" className="mt-6 w-full" onClick={goToLogin}>
        <LogIn /> Log in
      </Button>
    </main>
  );
}

export default function App() {
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    // After the first screen: tidy old uploads and get scans/photos ready for offline use.
    const timer = setTimeout(() => {
      void import('@/db/db').then((m) => m.purgeOldOriginals()).catch(() => undefined);
      void import('@/extract/ocrWarm').then((m) => m.scheduleOcrWarmup()).catch(() => undefined);
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const check = () => void checkSession().then((state) => setExpired(state === 'expired'));
    check();
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', check);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', check);
    };
  }, []);

  if (expired) return <LoginAgain />;

  return (
    <>
      <Suspense fallback={<FullPageLoading />}>
        <Routes routes={ROUTES} />
      </Suspense>
      <Suspense fallback={null}>
        <Toaster position="top-center" richColors closeButton toastOptions={{ duration: 4500 }} />
      </Suspense>
    </>
  );
}
