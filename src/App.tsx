import React, { useState, useEffect, useCallback } from 'react';
import { Bell, Sun, Moon, Mic, Globe, Menu, X, ShieldAlert, HeartPulse, Shield } from 'lucide-react';
import type {
  AccessibilitySettings,
  AuthUser,
  CivicReport,
  ElevenLabsStatus,
  LanguageCode,
  NotificationItem,
  RecyclingCentre,
  TransitRoute,
  TransitVehicle,
  VoiceSettings,
  WasteBin,
  WasteCollection,
} from './types.ts';
import { t } from './i18n/translations.ts';
import { apiFetch, setSessionToken } from './api/client.ts';
import { useGeolocation } from './hooks/useGeolocation.ts';
import { LandingPage } from './components/LandingPage.tsx';
import { CityMap } from './components/CityMap.tsx';
import { CivicModule } from './components/CivicModule.tsx';
import { TransitModule } from './components/TransitModule.tsx';
import { WasteModule } from './components/WasteModule.tsx';
import { AnalyticsCenter } from './components/AnalyticsCenter.tsx';
import { ProfileSettings } from './components/ProfileSettings.tsx';
import { NagarSaathiPanel } from './components/NagarSaathiPanel.tsx';
import { AuthModal } from './components/AuthModal.tsx';
import { WomenSafetyModule } from './components/WomenSafetyModule.tsx';
import { MedicalAssistanceModule } from './components/MedicalAssistanceModule.tsx';
import { CaregiverPortal } from './components/CaregiverPortal.tsx';
import { AdminDashboard } from './components/AdminDashboard.tsx';

type ActiveTab =
  | 'home'
  | 'overview'
  | 'civic'
  | 'safety'
  | 'medical'
  | 'caregiver'
  | 'admin'
  | 'mobility'
  | 'waste'
  | 'map'
  | 'analytics'
  | 'notifications'
  | 'profile';

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authBootstrapped, setAuthBootstrapped] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('home');
  const [language, setLanguage] = useState<LanguageCode>('en');
  const [darkMode, setDarkMode] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authInitialPortal, setAuthInitialPortal] = useState<'citizen' | 'caregiver' | 'authority' | 'admin'>('citizen');
  const [saathiOpen, setSaathiOpen] = useState(false);
  const [pendingCaregiverToken, setPendingCaregiverToken] = useState<string | null>(null);

  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({
    enabled: true,
    preferredLanguage: 'en',
    voiceId: '',
    speed: 1.0,
    autoPlay: true,
    continuousMode: false,
  });

  const [accessibility, setAccessibility] = useState<AccessibilitySettings>({
    largeText: false,
    highContrast: false,
  });

  const [elevenStatus, setElevenStatus] = useState<ElevenLabsStatus | null>(null);
  const [overviewStats, setOverviewStats] = useState<{
    civic: { total: number; resolved: number; active: number };
    transit: { verifiedRoutes: number; activeVehicles: number };
    waste: { totalBins: number; overflowingBins: number };
  } | null>(null);

  const [reports, setReports] = useState<CivicReport[]>([]);
  const [departments, setDepartments] = useState<
    Array<{ id: string; name: string; code: string; sla_hours: number; head_name: string }>
  >([]);
  const [officers, setOfficers] = useState<
    Array<{ id: string; department_id: string; department_name: string; name: string; badge_no: string; ward: string }>
  >([]);
  const [routes, setRoutes] = useState<TransitRoute[]>([]);
  const [vehicles, setVehicles] = useState<TransitVehicle[]>([]);
  const [bins, setBins] = useState<WasteBin[]>([]);
  const [collections, setCollections] = useState<WasteCollection[]>([]);
  const [recyclingCentres, setRecyclingCentres] = useState<RecyclingCentre[]>([]);
  const [leaderboard, setLeaderboard] = useState<
    Array<{ name: string; points: number; households_verified: number; streak_days: number }>
  >([]);
  const [myRewards, setMyRewards] = useState<{
    points: number;
    streak_days: number;
    badges: string[];
    history: Array<{ date: string; action: string; points: number }>;
  } | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  const { geo, requestLocation, setManualLocation } = useGeolocation();
  const copy = t(language);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', darkMode);
    root.classList.toggle('large-text-mode', accessibility.largeText);
    root.classList.toggle('high-contrast-mode', accessibility.highContrast);
  }, [darkMode, accessibility]);

  // Restore authenticated session across page refreshes + handle ?caregiverToken= links
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const cgToken = params.get('caregiverToken');
    if (cgToken) {
      setPendingCaregiverToken(cgToken);
      setAuthInitialPortal('caregiver');
      window.history.replaceState({}, '', window.location.pathname);
    }

    apiFetch<{
      user: AuthUser;
      preferences?: {
        voiceSettings?: Partial<VoiceSettings>;
        accessibility?: Partial<AccessibilitySettings>;
      };
    }>('/api/auth/me')
      .then((res) => {
        setUser(res.user);
        if (res.user.preferredLanguage) setLanguage(res.user.preferredLanguage);
        if (res.preferences?.voiceSettings) {
          setVoiceSettings((prev) => ({ ...prev, ...res.preferences!.voiceSettings }));
        }
        if (res.preferences?.accessibility) {
          setAccessibility((prev) => ({ ...prev, ...res.preferences!.accessibility }));
        }
        if (res.user.role === 'caregiver') setActiveTab('caregiver');
        else if (res.user.role === 'admin') setActiveTab('admin');
        else setActiveTab('overview');
      })
      .catch(() => {
        if (cgToken) setAuthModalOpen(true);
      })
      .finally(() => setAuthBootstrapped(true));
  }, []);

  const refreshElevenStatus = useCallback(() => {
    apiFetch<ElevenLabsStatus>('/api/voice/status?refresh=true')
      .then(setElevenStatus)
      .catch(() => {});
  }, []);

  const refreshAllData = useCallback(async () => {
    try {
      const pubRes = await apiFetch<typeof overviewStats>('/api/public/overview');
      setOverviewStats(pubRes);

      if (!user) {
        setReports([]);
        setDepartments([]);
        setOfficers([]);
        setRoutes([]);
        setVehicles([]);
        setBins([]);
        setCollections([]);
        setRecyclingCentres([]);
        setLeaderboard([]);
        setMyRewards(null);
        setNotifications([]);
        return;
      }

      if (user.role === 'caregiver') {
        // Caregivers strictly access caregiver portal endpoints only
        return;
      }

      const geoQs = geo.lat !== null && geo.lng !== null ? `?lat=${geo.lat}&lng=${geo.lng}` : '';
      const [civicRes, deptRes, transitRes, wasteRes, notifRes] = await Promise.all([
        apiFetch<{ reports: CivicReport[] }>(`/api/civic/reports${geoQs}`),
        apiFetch<{ departments: typeof departments; officers: typeof officers }>('/api/civic/departments'),
        apiFetch<{ routes: TransitRoute[]; vehicles: TransitVehicle[] }>('/api/transit/overview'),
        apiFetch<{
          bins: WasteBin[];
          collections: WasteCollection[];
          recyclingCentres: RecyclingCentre[];
          leaderboard: typeof leaderboard;
          myRewards: typeof myRewards;
        }>('/api/waste/overview'),
        apiFetch<{ notifications: NotificationItem[] }>('/api/notifications'),
      ]);

      setReports(civicRes.reports || []);
      setDepartments(deptRes.departments || []);
      setOfficers(deptRes.officers || []);
      setRoutes(transitRes.routes || []);
      setVehicles(transitRes.vehicles || []);
      setBins(wasteRes.bins || []);
      setCollections(wasteRes.collections || []);
      setRecyclingCentres(wasteRes.recyclingCentres || []);
      setLeaderboard(wasteRes.leaderboard || []);
      setMyRewards(wasteRes.myRewards || null);
      setNotifications(notifRes.notifications || []);
    } catch {
      // Transient fetch failures do not crash UI
    }
  }, [geo.lat, geo.lng, user]);

  useEffect(() => {
    refreshElevenStatus();
    refreshAllData();
  }, [refreshElevenStatus, refreshAllData]);

  // Authenticated real-time SSE stream subscription
  useEffect(() => {
    if (!user) return;
    const es = new EventSource('/api/events', { withCredentials: true });
    const handler = () => {
      refreshAllData();
    };
    es.addEventListener('civic_updated', handler);
    es.addEventListener('transit_updated', handler);
    es.addEventListener('waste_updated', handler);
    es.addEventListener('safety_updated', handler);
    return () => {
      es.close();
    };
  }, [user, refreshAllData]);

  const openAuthPortal = (portal: 'citizen' | 'caregiver' | 'authority' | 'admin' = 'citizen') => {
    setAuthInitialPortal(portal);
    setAuthModalOpen(true);
  };

  const handleLanguageChange = async (nextLang: LanguageCode) => {
    setLanguage(nextLang);
    setVoiceSettings((prev) => ({ ...prev, preferredLanguage: nextLang }));
    if (user) {
      apiFetch('/api/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferredLanguage: nextLang }),
      }).catch(() => {});
    }
  };

  const handleUpdateVoiceSettings = (next: VoiceSettings) => {
    setVoiceSettings(next);
    if (user) {
      apiFetch('/api/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ voiceSettings: next }),
      }).catch(() => {});
    }
  };

  const handleUpdateAccessibility = (next: AccessibilitySettings) => {
    setAccessibility(next);
    if (user) {
      apiFetch('/api/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ accessibility: next }),
      }).catch(() => {});
    }
  };

  const handleAuthenticated = async (authUser: AuthUser) => {
    setUser(authUser);
    if (authUser.preferredLanguage) setLanguage(authUser.preferredLanguage);
    if (authUser.role === 'caregiver') setActiveTab('caregiver');
    else if (authUser.role === 'admin') setActiveTab('admin');
    else if (authUser.role === 'transit_driver') setActiveTab('mobility');
    else if (authUser.role === 'sanitation_driver') setActiveTab('waste');
    else setActiveTab('overview');
  };

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    setSessionToken(null);
    setUser(null);
    setReports([]);
    setNotifications([]);
    setActiveTab('home');
  };

  const handleMarkNotifRead = async (id: string) => {
    await apiFetch(`/api/notifications/${id}/read`, { method: 'PATCH' });
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: 1 } : n)));
  };

  const navigateProtected = (target: ActiveTab) => {
    if (target === 'home') {
      setActiveTab('home');
      return;
    }
    if (!user) {
      openAuthPortal(target === 'caregiver' ? 'caregiver' : target === 'admin' ? 'admin' : 'citizen');
      return;
    }
    // Enforce frontend role alignment cleanly (backend enforces strictly too)
    if (target === 'admin' && user.role !== 'admin') return;
    if (target === 'caregiver' && user.role !== 'caregiver') return;
    if (target === 'safety' && user.role !== 'citizen') return;
    setActiveTab(target);
  };

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  // Strict max 5 top-bar links matched to the active role
  const topNavItems: Array<{ id: ActiveTab; label: string }> =
    !user
      ? [
          { id: 'home', label: copy.navHome },
          { id: 'civic', label: copy.navCivic },
          { id: 'safety', label: copy.navSafety },
          { id: 'medical', label: copy.navMedical },
          { id: 'map', label: copy.navMap },
        ]
      : user.role === 'caregiver'
        ? [
            { id: 'caregiver', label: copy.navCaregiver },
            { id: 'profile', label: copy.navProfile },
          ]
        : user.role === 'admin'
          ? [
              { id: 'admin', label: copy.navAdmin },
              { id: 'civic', label: 'All Reports' },
              { id: 'map', label: copy.navMap },
              { id: 'analytics', label: copy.navAnalytics },
              { id: 'profile', label: copy.navProfile },
            ]
          : user.role === 'authority'
            ? [
                { id: 'overview', label: copy.navOverview },
                { id: 'civic', label: 'Department Queue' },
                { id: 'mobility', label: copy.navMobility },
                { id: 'waste', label: copy.navWaste },
                { id: 'map', label: copy.navMap },
              ]
            : [
                { id: 'overview', label: copy.navOverview },
                { id: 'civic', label: copy.navCivic },
                { id: 'safety', label: copy.navSafety },
                { id: 'medical', label: copy.navMedical },
                { id: 'map', label: copy.navMap },
              ];

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAF9] dark:bg-[#0B110E] text-slate-900 dark:text-slate-100">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 bg-white/95 dark:bg-[#111916]/95 backdrop-blur-sm border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
          <button
            type="button"
            onClick={() => setActiveTab(user ? (user.role === 'caregiver' ? 'caregiver' : user.role === 'admin' ? 'admin' : 'overview') : 'home')}
            className="font-display text-lg font-extrabold tracking-tight text-slate-950 dark:text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            NAGAR AI
          </button>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-300">
            {topNavItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateProtected(item.id)}
                className={`whitespace-nowrap shrink-0 py-1 transition-colors cursor-pointer ${
                  activeTab === item.id
                    ? 'text-emerald-700 dark:text-emerald-400 underline underline-offset-8 decoration-2'
                    : 'hover:text-slate-950 dark:hover:text-white'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-2 shrink-0">
            {user ? (
              <button
                type="button"
                onClick={() => setActiveTab('profile')}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {user.name.split(' ')[0]} · {user.role.replace('_', ' ')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => openAuthPortal('citizen')}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Sign In / Register
              </button>
            )}
            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-label="Toggle Menu"
              className="md:hidden p-2 rounded-lg text-slate-600 dark:text-slate-300 cursor-pointer"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111916] px-4 py-3 flex flex-col gap-2">
            {topNavItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  navigateProtected(item.id);
                  setMobileMenuOpen(false);
                }}
                className="text-left py-2 text-sm font-medium text-slate-800 dark:text-slate-200"
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </header>

      {/* Secondary Workspace Toolbar */}
      {user && activeTab !== 'home' && (
        <div className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111916]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              {user.role === 'citizen' &&
                (
                  [
                    ['overview', copy.navOverview],
                    ['safety', copy.navSafety],
                    ['medical', copy.navMedical],
                    ['mobility', copy.navMobility],
                    ['waste', copy.navWaste],
                    ['analytics', copy.navAnalytics],
                    ['notifications', `${copy.navNotifications}${unreadCount ? ` (${unreadCount})` : ''}`],
                    ['profile', copy.navProfile],
                  ] as Array<[ActiveTab, string]>
                ).map(([tabId, label]) => (
                  <button
                    key={tabId}
                    type="button"
                    onClick={() => setActiveTab(tabId)}
                    className={`px-3 py-1.5 rounded-md font-medium whitespace-nowrap cursor-pointer ${
                      activeTab === tabId
                        ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}

              {(user.role === 'authority' || user.role === 'transit_driver' || user.role === 'sanitation_driver') &&
                (
                  [
                    ['overview', copy.navOverview],
                    ['civic', 'Civic Queue'],
                    ['mobility', copy.navMobility],
                    ['waste', copy.navWaste],
                    ['analytics', copy.navAnalytics],
                    ['notifications', `${copy.navNotifications}${unreadCount ? ` (${unreadCount})` : ''}`],
                    ['profile', copy.navProfile],
                  ] as Array<[ActiveTab, string]>
                ).map(([tabId, label]) => (
                  <button
                    key={tabId}
                    type="button"
                    onClick={() => setActiveTab(tabId)}
                    className={`px-3 py-1.5 rounded-md font-medium whitespace-nowrap cursor-pointer ${
                      activeTab === tabId
                        ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleLanguageChange(language === 'en' ? 'hi' : 'en')}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer"
              >
                <Globe className="w-3.5 h-3.5" />
                {language === 'en' ? 'English / हिन्दी' : 'हिन्दी / English'}
              </button>

              <button
                type="button"
                onClick={() => setDarkMode((v) => !v)}
                aria-label="Toggle Light/Dark Theme"
                className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer"
              >
                {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              </button>

              {user.role !== 'caregiver' && (
                <button
                  type="button"
                  onClick={() => setSaathiOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 font-medium cursor-pointer"
                >
                  <Mic className="w-3.5 h-3.5" />
                  {copy.saathiName}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1">
        {!authBootstrapped ? (
          <div className="max-w-7xl mx-auto px-4 py-16 text-center text-sm text-slate-500">
            Restoring authenticated session...
          </div>
        ) : activeTab === 'home' || !user ? (
          <LandingPage
            language={language}
            overviewStats={overviewStats}
            onExplorePlatform={() => openAuthPortal('citizen')}
            onNavigateTab={(tab) => navigateProtected(tab as ActiveTab)}
            onOpenSaathi={() => {
              if (!user) openAuthPortal('citizen');
              else setSaathiOpen(true);
            }}
            onOpenAuth={openAuthPortal}
          />
        ) : (
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            {activeTab === 'overview' && (
              <div className="space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h1 className="text-2xl font-display font-bold text-slate-950 dark:text-white">
                      Welcome, {user.name}
                    </h1>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      {user.role === 'citizen'
                        ? 'Your private Citizen Dashboard — personal reports, Women Safety & SOS, nearby medical assistance, and mobility.'
                        : `Authenticated ${user.role.replace('_', ' ')} Workspace`}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {user.role === 'citizen' && (
                      <button
                        type="button"
                        onClick={() => setActiveTab('safety')}
                        className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-lg bg-red-600 text-white hover:bg-red-700 cursor-pointer"
                      >
                        <ShieldAlert className="w-4 h-4" />
                        Women Safety &amp; SOS
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setSaathiOpen(true)}
                      className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
                    >
                      <Mic className="w-4 h-4" />
                      Speak with {copy.saathiName}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <button
                    type="button"
                    onClick={() => setActiveTab('civic')}
                    className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-emerald-600 transition-colors cursor-pointer"
                  >
                    <div className="text-xs text-slate-500">
                      {user.role === 'citizen' ? 'My Civic Reports' : 'Assigned Department Reports'}
                    </div>
                    <div className="mt-1 text-2xl font-display font-bold tabular-nums">{reports.length} Reports</div>
                    <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
                      {reports.length === 0
                        ? copy.noReportsYet
                        : `${reports.filter((r) => r.isOverdue).length} overdue SLA · View`}
                    </div>
                  </button>

                  {user.role === 'citizen' ? (
                    <button
                      type="button"
                      onClick={() => setActiveTab('medical')}
                      className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-emerald-600 transition-colors cursor-pointer"
                    >
                      <div className="text-xs text-slate-500 flex items-center gap-1.5">
                        <HeartPulse className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                        Medical &amp; Safety Aid
                      </div>
                      <div className="mt-1 text-lg font-display font-bold">Nearby Hospitals &amp; Police</div>
                      <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
                        Live GPS OpenStreetMap lookup →
                      </div>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setActiveTab('mobility')}
                      className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-emerald-600 transition-colors cursor-pointer"
                    >
                      <div className="text-xs text-slate-500">Smart Mobility</div>
                      <div className="mt-1 text-2xl font-display font-bold tabular-nums">{routes.length} Routes</div>
                      <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
                        {vehicles.filter((v) => v.status === 'active').length} active vehicles
                      </div>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setActiveTab('waste')}
                    className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-emerald-600 transition-colors cursor-pointer"
                  >
                    <div className="text-xs text-slate-500">Waste &amp; Rewards</div>
                    <div className="mt-1 text-2xl font-display font-bold tabular-nums">
                      {myRewards ? `${myRewards.points} pts` : `${bins.length} Smart Bins`}
                    </div>
                    <div className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                      {bins.filter((b) => b.status === 'overflowing').length} overflowing alert
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('notifications')}
                    className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-emerald-600 transition-colors cursor-pointer"
                  >
                    <div className="text-xs text-slate-500">My Notifications</div>
                    <div className="mt-1 text-2xl font-display font-bold tabular-nums">{unreadCount} Unread</div>
                    <div className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                      {notifications.length === 0 ? 'No notifications yet' : 'View personal alerts'}
                    </div>
                  </button>
                </div>

                <CityMap
                  geo={geo}
                  onRequestGps={requestLocation}
                  onManualPin={setManualLocation}
                  reports={reports}
                  routes={routes}
                  vehicles={vehicles}
                  bins={bins}
                  recyclingCentres={recyclingCentres}
                  language={language}
                  onRefreshData={refreshAllData}
                  compact
                />
              </div>
            )}

            {activeTab === 'safety' && (
              <WomenSafetyModule
                user={user}
                language={language}
                geo={geo}
                onRequestGps={requestLocation}
                onManualPin={setManualLocation}
                onNavigateTab={(tab) => navigateProtected(tab as ActiveTab)}
              />
            )}

            {activeTab === 'medical' && (
              <MedicalAssistanceModule
                user={user}
                geo={geo}
                onRequestGps={requestLocation}
                onManualPin={setManualLocation}
                onNavigateTab={(tab) => navigateProtected(tab as ActiveTab)}
              />
            )}

            {activeTab === 'caregiver' && (
              <CaregiverPortal
                user={user}
                initialAccessToken={pendingCaregiverToken}
                onClearInitialToken={() => setPendingCaregiverToken(null)}
              />
            )}

            {activeTab === 'admin' && <AdminDashboard user={user} departments={departments} />}

            {activeTab === 'civic' && (
              <CivicModule
                user={user}
                language={language}
                geo={geo}
                onRequestGps={requestLocation}
                reports={reports}
                departments={departments}
                officers={officers}
                onRefresh={refreshAllData}
                onRequireAuth={() => openAuthPortal('citizen')}
              />
            )}

            {activeTab === 'mobility' && (
              <TransitModule
                user={user}
                geo={geo}
                routes={routes}
                vehicles={vehicles}
                onRefresh={refreshAllData}
                onRequireAuth={() => openAuthPortal('citizen')}
              />
            )}

            {activeTab === 'waste' && (
              <WasteModule
                user={user}
                language={language}
                geo={geo}
                bins={bins}
                collections={collections}
                recyclingCentres={recyclingCentres}
                leaderboard={leaderboard}
                myRewards={myRewards}
                onRefresh={refreshAllData}
                onRequireAuth={() => openAuthPortal('citizen')}
              />
            )}

            {activeTab === 'map' && (
              <div className="space-y-4">
                <div>
                  <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white flex items-center gap-2">
                    <Shield className="w-5 h-5 text-emerald-700 dark:text-emerald-400" />
                    Unified Smart City Map
                  </h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    Interactive OpenStreetMap view showing your authorized civic complaints, transit routes, vehicles, smart bins, and recycling centres.
                  </p>
                </div>
                <CityMap
                  geo={geo}
                  onRequestGps={requestLocation}
                  onManualPin={setManualLocation}
                  reports={reports}
                  routes={routes}
                  vehicles={vehicles}
                  bins={bins}
                  recyclingCentres={recyclingCentres}
                  language={language}
                  onRefreshData={refreshAllData}
                />
              </div>
            )}

            {activeTab === 'analytics' && <AnalyticsCenter user={user} />}

            {activeTab === 'notifications' && (
              <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 max-w-3xl">
                <h2 className="text-xl font-display font-bold flex items-center gap-2">
                  <Bell className="w-5 h-5 text-emerald-700 dark:text-emerald-400" />
                  Notifications Center
                </h2>
                {notifications.length === 0 ? (
                  <p className="text-sm text-slate-500">No notifications yet.</p>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {notifications.map((n) => (
                      <div key={n.id} className="py-3.5 flex items-start justify-between gap-4">
                        <div>
                          <div className="text-sm font-semibold text-slate-900 dark:text-white">{n.title}</div>
                          <div className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">
                            {language === 'hi' && n.message_hi ? n.message_hi : n.message}
                          </div>
                          <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-1">
                            {new Date(n.created_at).toLocaleString()}
                          </div>
                        </div>
                        {!n.is_read && (
                          <button
                            type="button"
                            onClick={() => handleMarkNotifRead(n.id)}
                            className="text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:underline shrink-0 cursor-pointer"
                          >
                            Mark read
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'profile' && (
              <ProfileSettings
                user={user}
                language={language}
                onChangeLanguage={handleLanguageChange}
                voiceSettings={voiceSettings}
                onChangeVoiceSettings={handleUpdateVoiceSettings}
                accessibility={accessibility}
                onChangeAccessibility={handleUpdateAccessibility}
                elevenStatus={elevenStatus}
                onRefreshStatus={refreshElevenStatus}
                onLogout={handleLogout}
                onOpenAuth={() => openAuthPortal('citizen')}
              />
            )}
          </div>
        )}
      </main>

      {/* Persistent NAGAR SAATHI ElevenLabs Voice Companion (for Citizens, Officers, Operators) */}
      {user && user.role !== 'caregiver' && (
        <NagarSaathiPanel
          user={user}
          language={language}
          onChangeLanguage={handleLanguageChange}
          activeModule={activeTab}
          geo={geo}
          onRequestGps={requestLocation}
          voiceSettings={voiceSettings}
          onUpdateVoiceSettings={handleUpdateVoiceSettings}
          elevenStatus={elevenStatus}
          isOpen={saathiOpen}
          onToggleOpen={setSaathiOpen}
          onNavigateModule={(dest) => {
            const valid: ActiveTab[] = [
              'overview',
              'civic',
              'safety',
              'medical',
              'mobility',
              'waste',
              'map',
              'analytics',
              'notifications',
              'profile',
            ];
            if (valid.includes(dest as ActiveTab)) navigateProtected(dest as ActiveTab);
          }}
          onRefreshCityData={refreshAllData}
          onRequireAuth={() => openAuthPortal('citizen')}
        />
      )}

      <AuthModal
        isOpen={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        onAuthenticated={handleAuthenticated}
        initialPortal={authInitialPortal}
      />
    </div>
  );
}
