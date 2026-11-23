import React, { useState } from 'react';
import { ArrowRight, MapPin, Mic, ShieldAlert, Bus, Trash2, CheckCircle2, HeartPulse } from 'lucide-react';
import type { LanguageCode } from '../types.ts';
import { t } from '../i18n/translations.ts';

interface LandingPageProps {
  language: LanguageCode;
  overviewStats: {
    civic: { total: number; resolved: number; active: number };
    transit: { verifiedRoutes: number; activeVehicles: number };
    waste: { totalBins: number; overflowingBins: number };
  } | null;
  onExplorePlatform: () => void;
  onNavigateTab: (tab: string) => void;
  onOpenSaathi: () => void;
  onOpenAuth: (portal?: 'citizen' | 'caregiver' | 'authority' | 'admin') => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({
  language,
  overviewStats,
  onExplorePlatform,
  onNavigateTab,
  onOpenSaathi,
  onOpenAuth,
}) => {
  const copy = t(language);
  const [imgErrors, setImgErrors] = useState<Record<string, boolean>>({});
  const markError = (key: string) => setImgErrors((p) => ({ ...p, [key]: true }));

  return (
    <div className="bg-[#F8FAF9] dark:bg-[#0B110E] text-slate-900 dark:text-slate-100">
      {/* Hero Split Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-10 pb-12">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          <div className="lg:col-span-6 flex flex-col justify-between py-2">
            <div>
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400 tracking-wide">
                NAGAR AI · {copy.tagline}
              </p>
              <h1
                className="mt-4 font-display font-bold tracking-tight text-slate-950 dark:text-white leading-[1.08] text-balance"
                style={{ fontSize: 'clamp(2.25rem, 4vw, 3.5rem)' }}
              >
                {copy.heroHeadline}
              </h1>
              <p className="mt-5 text-base sm:text-lg text-slate-600 dark:text-slate-300 leading-relaxed max-w-xl">
                {copy.heroSubheading}
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={onExplorePlatform}
                  className="inline-flex items-center gap-2 px-5 py-3 text-sm font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {copy.explorePlatform}
                  <ArrowRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onOpenAuth('caregiver')}
                  className="inline-flex items-center gap-2 px-5 py-3 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#111916] text-slate-800 dark:text-slate-100 hover:border-emerald-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Caregiver Portal
                </button>
                <button
                  type="button"
                  onClick={() => onNavigateTab('map')}
                  className="inline-flex items-center gap-2 px-4 py-3 text-sm font-medium text-emerald-800 dark:text-emerald-400 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <MapPin className="w-4 h-4" />
                  {copy.exploreMap}
                </button>
              </div>
            </div>

            <div className="mt-8 pt-6 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="text-xs font-semibold text-slate-900 dark:text-white">
                  {copy.saathiName} Voice Companion
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{copy.saathiTagline}</div>
              </div>
              <button
                type="button"
                onClick={onOpenSaathi}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100 dark:hover:bg-emerald-950 transition-colors cursor-pointer"
              >
                <Mic className="w-3.5 h-3.5" />
                Speak with Nagar Saathi
              </button>
            </div>
          </div>

          <div className="lg:col-span-6">
            <div className="relative h-full min-h-[300px] lg:min-h-[420px] rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-200 dark:bg-slate-900">
              {!imgErrors.hero ? (
                <img
                  src="/src/assets/images/hero_smart_city_1795458468945.jpg"
                  alt="Modern green smart city boulevard with electric shared auto-rickshaws and transit shelter"
                  referrerPolicy="no-referrer"
                  onError={() => markError('hero')}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-8 bg-gradient-to-br from-emerald-900 to-slate-900 text-white">
                  <MapPin className="w-10 h-10 text-emerald-400 mb-3" />
                  <p className="font-display font-semibold text-lg">NAGAR AI Smart City Corridor</p>
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 p-5 bg-gradient-to-t from-black/75 via-black/35 to-transparent text-white">
                <div className="text-xs text-emerald-300 font-medium">
                  Authenticated Municipal Operations · Strict Role Isolation
                </div>
                <div className="text-sm font-medium mt-1">
                  Civic Issues, Women Safety &amp; SOS, Nearby Hospitals, Shared Transit, and Waste Management
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Full-Width 4-Column Genuine Database Strip (Zero hardcoded fake fallback numbers) */}
        <div className="mt-8 grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
            <div className="text-xs text-slate-500 dark:text-slate-400">Active Civic Reports</div>
            <div className="mt-2 text-2xl font-display font-bold tabular-nums text-slate-900 dark:text-white">
              {overviewStats?.civic.active ?? 0}
            </div>
            <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-400 tabular-nums">
              {overviewStats?.civic.resolved ?? 0} resolved in database
            </div>
          </div>

          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
            <div className="text-xs text-slate-500 dark:text-slate-400">Verified Transit Routes</div>
            <div className="mt-2 text-2xl font-display font-bold tabular-nums text-slate-900 dark:text-white">
              {overviewStats?.transit.verifiedRoutes ?? 0}
            </div>
            <div className="mt-1 text-xs text-slate-600 dark:text-slate-400 tabular-nums">
              {overviewStats?.transit.activeVehicles ?? 0} active registered vehicles
            </div>
          </div>

          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
            <div className="text-xs text-slate-500 dark:text-slate-400">Registered Smart Bins</div>
            <div className="mt-2 text-2xl font-display font-bold tabular-nums text-slate-900 dark:text-white">
              {overviewStats?.waste.totalBins ?? 0}
            </div>
            <div className="mt-1 text-xs text-amber-700 dark:text-amber-400 tabular-nums">
              {overviewStats?.waste.overflowingBins ?? 0} overflowing alert
            </div>
          </div>

          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
            <div className="text-xs text-slate-500 dark:text-slate-400">Safety &amp; Voice AI</div>
            <div className="mt-2 text-2xl font-display font-bold text-slate-900 dark:text-white">
              EN / हिन्दी
            </div>
            <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
              Live GPS SOS · ElevenLabs Voice
            </div>
          </div>
        </div>
      </section>

      {/* Solution Modules */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 border-t border-slate-200 dark:border-slate-800">
        <div className="max-w-2xl">
          <h2 className="text-2xl sm:text-3xl font-display font-bold text-slate-950 dark:text-white tracking-tight">
            Integrated Urban &amp; Safety Operations
          </h2>
          <p className="mt-2 text-sm sm:text-base text-slate-600 dark:text-slate-300">
            Role-isolated dashboards with live browser geolocation, caregiver verification, and municipal accountability.
          </p>
        </div>

        <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <article className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden flex flex-col">
            <div className="aspect-[4/3] bg-slate-100 dark:bg-slate-900 overflow-hidden">
              {!imgErrors.civic ? (
                <img
                  src="/src/assets/images/module_civic_infrastructure_1795458468961.jpg"
                  alt="Municipal street inspection and repaired asphalt infrastructure"
                  referrerPolicy="no-referrer"
                  onError={() => markError('civic')}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-emerald-950/20">
                  <CheckCircle2 className="w-10 h-10 text-emerald-700" />
                </div>
              )}
            </div>
            <div className="p-5 flex-1 flex flex-col justify-between">
              <div>
                <div className="text-xs text-slate-500">01. Civic Issues</div>
                <h3 className="mt-1 text-base font-display font-semibold text-slate-950 dark:text-white">
                  Real-Time Issue Resolution
                </h3>
                <p className="mt-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  Submit private citizen reports with verified GPS, track official SLA progress, and receive officer status updates.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigateTab('civic')}
                className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
              >
                Open Civic Issues <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </article>

          <article className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden flex flex-col">
            <div className="aspect-[4/3] bg-gradient-to-br from-emerald-950 to-slate-900 flex flex-col items-center justify-center p-6 text-white">
              <ShieldAlert className="w-11 h-11 text-red-400 mb-2" />
              <HeartPulse className="w-7 h-7 text-emerald-400" />
            </div>
            <div className="p-5 flex-1 flex flex-col justify-between">
              <div>
                <div className="text-xs text-slate-500">02. Women Safety &amp; Medical</div>
                <h3 className="mt-1 text-base font-display font-semibold text-slate-950 dark:text-white">
                  Live GPS SOS &amp; Caregiver Alerts
                </h3>
                <p className="mt-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  Share live safety location with verified caregivers, trigger SOS with one confirmation, and locate nearby hospitals &amp; police.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigateTab('safety')}
                className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
              >
                Open Safety &amp; SOS <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </article>

          <article className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden flex flex-col">
            <div className="aspect-[4/3] bg-slate-100 dark:bg-slate-900 overflow-hidden">
              {!imgErrors.mobility ? (
                <img
                  src="/src/assets/images/module_smart_mobility_1795458469911.jpg"
                  alt="Electric shared auto-rickshaws at organized metro feeder bay"
                  referrerPolicy="no-referrer"
                  onError={() => markError('mobility')}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-emerald-950/20">
                  <Bus className="w-10 h-10 text-emerald-700" />
                </div>
              )}
            </div>
            <div className="p-5 flex-1 flex flex-col justify-between">
              <div>
                <div className="text-xs text-slate-500">03. Smart Mobility</div>
                <h3 className="mt-1 text-base font-display font-semibold text-slate-950 dark:text-white">
                  Shared Auto &amp; Mini-Bus Routing
                </h3>
                <p className="mt-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  Submit and discover community or authority-verified feeder routes with live operator availability.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigateTab('mobility')}
                className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
              >
                Open Smart Mobility <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </article>

          <article className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden flex flex-col">
            <div className="aspect-[4/3] bg-slate-100 dark:bg-slate-900 overflow-hidden">
              {!imgErrors.waste ? (
                <img
                  src="/src/assets/images/module_waste_management_1795458469917.jpg"
                  alt="Color-coded urban smart waste segregation bins with solar lids"
                  referrerPolicy="no-referrer"
                  onError={() => markError('waste')}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-emerald-950/20">
                  <Trash2 className="w-10 h-10 text-emerald-700" />
                </div>
              )}
            </div>
            <div className="p-5 flex-1 flex flex-col justify-between">
              <div>
                <div className="text-xs text-slate-500">04. Waste Management</div>
                <h3 className="mt-1 text-base font-display font-semibold text-slate-950 dark:text-white">
                  AI Segregation &amp; Collections
                </h3>
                <p className="mt-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  Classify waste items with Gemini AI, monitor registered bins, and track citizen household segregation points.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigateTab('waste')}
                className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
              >
                Open Waste Management <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </article>
        </div>
      </section>

      {/* Role-Based Portals */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 border-t border-slate-200 dark:border-slate-800">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
          <div className="lg:col-span-5">
            <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white">
              Four Strictly Isolated Portals
            </h2>
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              Every user account is verified server-side via HttpOnly session cookies and strict role-based authorization. Zero shared dummy records.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onOpenAuth('citizen')}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
              >
                Citizen Portal
              </button>
              <button
                type="button"
                onClick={() => onOpenAuth('caregiver')}
                className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Caregiver Portal
              </button>
              <button
                type="button"
                onClick={() => onOpenAuth('authority')}
                className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Officer Portal
              </button>
              <button
                type="button"
                onClick={() => onOpenAuth('admin')}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-950 cursor-pointer"
              >
                Admin Console
              </button>
            </div>
          </div>

          <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[
              {
                role: 'Citizen Dashboard',
                desc: 'Manage personal civic complaints, activate Women Safety GPS sharing, trigger Emergency SOS, link caregivers, and locate nearby hospitals.',
              },
              {
                role: 'Caregiver Access Portal',
                desc: 'Verify mobile invitations and access tokens to view strictly authorized citizen live GPS updates, SOS alerts, and medical profiles.',
              },
              {
                role: 'Authority Officer Portal',
                desc: 'Review department-assigned complaints, update verification and resolution timelines, and monitor municipal fleet tasks.',
              },
              {
                role: 'Administrator Control Center',
                desc: 'View genuine database statistics, provision Officer accounts, inspect registered users, and audit security logs.',
              },
            ].map((item) => (
              <div
                key={item.role}
                className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5"
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" />
                  {item.role}
                </div>
                <p className="mt-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E1512]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
          <div>
            <span className="font-display font-bold text-slate-900 dark:text-white">NAGAR AI</span>
            <span className="mx-2">·</span>
            <span>Simplicity for citizens. Intelligence for the city. Accountability for everyone.</span>
          </div>
          <div className="flex flex-wrap items-center gap-5">
            <button type="button" onClick={() => onOpenAuth('citizen')} className="hover:text-slate-900 dark:hover:text-white cursor-pointer">
              Citizen Login
            </button>
            <button type="button" onClick={() => onOpenAuth('caregiver')} className="hover:text-slate-900 dark:hover:text-white cursor-pointer">
              Caregiver Portal
            </button>
            <button type="button" onClick={() => onOpenAuth('authority')} className="hover:text-slate-900 dark:hover:text-white cursor-pointer">
              Officer Login
            </button>
            <button type="button" onClick={() => onOpenAuth('admin')} className="hover:text-slate-900 dark:hover:text-white cursor-pointer">
              Admin Login
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
};
