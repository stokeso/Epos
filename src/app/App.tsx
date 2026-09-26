/**
 * The app root: boots the data layer, then renders the hash router (architecture §7.1).
 * Every route of §7.1 is wired here; screen packages replace the placeholder components at the
 * same paths and export names (docs/ui-plan.md §8).
 */
import { useEffect } from 'react';
import { createHashRouter, Navigate, Outlet, RouterProvider, type RouteObject } from 'react-router-dom';
import { LoginScreen } from '../screens/login/LoginScreen';
import { PayScreen } from '../screens/pay/PayScreen';
import { SetupScreen } from '../screens/setup/SetupScreen';
import { TillScreen } from '../screens/till/TillScreen';
import { useAppStore } from '../store/appStore';
import { AppShell } from './AppShell';
import { bootstrap, STORAGE_UNAVAILABLE_MESSAGE } from './bootstrap';
import { BootScreen, RouteError, StorageErrorScreen } from './FullScreen';
import { GlobalUi } from './GlobalUi';
import { IndexRedirect, LoginGuard, RequireSession, SetupGuard } from './guards';
import { useAutoLock } from './useAutoLock';

function RootLayout() {
  useAutoLock();
  return (
    <>
      <Outlet />
      <GlobalUi />
    </>
  );
}

/**
 * Screens outside the selling path load on demand (their own chunks, precached by the PWA, so
 * they still work offline). Setup, Login, Till and Pay are in the main chunk.
 */
const lazyRoutes: RouteObject[] = [
  { path: 'tabs', lazy: async () => ({ Component: (await import('../screens/tabs/TabsScreen')).TabsScreen }) },
  { path: 'bookings', lazy: async () => ({ Component: (await import('../screens/bookings/BookingsScreen')).BookingsScreen }) },
  { path: 'bookings/:id', lazy: async () => ({ Component: (await import('../screens/bookings/BookingDetailScreen')).BookingDetailScreen }) },
  { path: 'members', lazy: async () => ({ Component: (await import('../screens/members/MembersScreen')).MembersScreen }) },
  { path: 'refunds', lazy: async () => ({ Component: (await import('../screens/refunds/RefundScreen')).RefundScreen }) },
  { path: 'period', lazy: async () => ({ Component: (await import('../screens/period/PeriodScreen')).PeriodScreen }) },
  {
    path: 'reports/product-sales',
    lazy: async () => ({ Component: (await import('../screens/reports/ProductSalesReportScreen')).ProductSalesReportScreen }),
  },
  { path: 'reports/vat', lazy: async () => ({ Component: (await import('../screens/reports/VatReportScreen')).VatReportScreen }) },
  { path: 'backoffice', lazy: async () => ({ Component: (await import('../screens/backoffice/BackOfficeMenu')).BackOfficeMenu }) },
  { path: 'backoffice/products', lazy: async () => ({ Component: (await import('../screens/backoffice/ProductsScreen')).ProductsScreen }) },
  { path: 'backoffice/categories', lazy: async () => ({ Component: (await import('../screens/backoffice/CategoriesScreen')).CategoriesScreen }) },
  { path: 'backoffice/deals', lazy: async () => ({ Component: (await import('../screens/backoffice/DealsScreen')).DealsScreen }) },
  { path: 'backoffice/staff', lazy: async () => ({ Component: (await import('../screens/backoffice/StaffScreen')).StaffScreen }) },
  { path: 'backoffice/stock', lazy: async () => ({ Component: (await import('../screens/backoffice/StockScreen')).StockScreen }) },
  { path: 'backoffice/settings', lazy: async () => ({ Component: (await import('../screens/backoffice/SettingsScreen')).SettingsScreen }) },
  { path: 'backoffice/backup', lazy: async () => ({ Component: (await import('../screens/backoffice/BackupScreen')).BackupScreen }) },
];

/** Dev-only component gallery (#/dev/components); not in production builds. */
const devRoutes: RouteObject[] = import.meta.env.DEV
  ? [
      {
        path: 'dev/components',
        lazy: async () => {
          const { ComponentGallery } = await import('./dev/ComponentGallery');
          return { Component: ComponentGallery };
        },
      },
    ]
  : [];

const routes: RouteObject[] = [
  {
    path: '/',
    element: <RootLayout />,
    errorElement: <RouteError />,
    hydrateFallbackElement: <BootScreen />,
    children: [
      { index: true, element: <IndexRedirect /> },
      {
        path: 'setup',
        element: (
          <SetupGuard>
            <SetupScreen />
          </SetupGuard>
        ),
      },
      {
        path: 'login',
        element: (
          <LoginGuard>
            <LoginScreen />
          </LoginGuard>
        ),
      },
      {
        element: (
          <RequireSession>
            <AppShell />
          </RequireSession>
        ),
        children: [
          { path: 'till', element: <TillScreen /> },
          { path: 'pay', element: <PayScreen /> },
          { path: 'reports', element: <Navigate to="/reports/product-sales" replace /> },
          ...lazyRoutes,
          ...devRoutes,
        ],
      },
      { path: '*', element: <IndexRedirect /> },
    ],
  },
];

const router = createHashRouter(routes);

export function App() {
  const status = useAppStore((s) => s.status);
  const bootError = useAppStore((s) => s.bootError);

  useEffect(() => {
    void useAppStore.getState().boot(bootstrap, STORAGE_UNAVAILABLE_MESSAGE);
  }, []);

  if (status === 'booting') return <BootScreen />;
  if (status === 'failed') return <StorageErrorScreen message={bootError ?? STORAGE_UNAVAILABLE_MESSAGE} />;
  return <RouterProvider router={router} />;
}
