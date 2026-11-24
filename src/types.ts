export type UserRole =
  | 'citizen'
  | 'authority'
  | 'admin'
  | 'caregiver'
  | 'transit_driver'
  | 'sanitation_driver';

export type LanguageCode = 'en' | 'hi';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: UserRole;
  departmentId?: string;
  preferredLanguage: LanguageCode;
}

export type VoiceState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'processing'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'error';

export interface VoiceSettings {
  enabled: boolean;
  preferredLanguage: LanguageCode;
  voiceId: string;
  speed: number;
  autoPlay: boolean;
  continuousMode: boolean;
}

export interface AccessibilitySettings {
  largeText: boolean;
  highContrast: boolean;
}

export interface ElevenLabsStatus {
  configured: boolean;
  connected: boolean;
  agentConfigured: boolean;
  defaultVoiceId: string;
  ttsModel: string;
  sttModel: string;
  tier?: string;
  characterCount?: number;
  characterLimit?: number;
  error?: string;
  geminiConfigured?: boolean;
  checkedAt?: string;
}

export interface VoiceOption {
  voiceId: string;
  name: string;
  category: string;
  accent?: string;
  gender?: string;
  description?: string;
  previewUrl?: string;
  supportsMultilingual: boolean;
}

export interface GeoLocationState {
  status: 'idle' | 'requesting' | 'acquired' | 'denied' | 'timeout' | 'unavailable' | 'manual';
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  address: string;
  ward: string;
  timestamp: string | null;
  errorMessage: string | null;
}

export interface CivicActivityItem {
  id: string;
  report_id: string;
  previous_status: string | null;
  new_status: string;
  actor_name: string;
  actor_role: string;
  comment: string;
  created_at: string;
}

export interface CivicReport {
  id: string;
  report_code: string;
  user_id: string;
  category: string;
  title: string;
  description: string;
  ai_enhanced_description?: string;
  evidenceUrls: string[];
  beforePhotoUrls?: string[];
  resolutionEvidenceUrls: string[];
  lat: number;
  lng: number;
  accuracy_m: number | null;
  location_source: string;
  address: string;
  landmark: string;
  ward: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  is_emergency?: number;
  status:
    | 'Submitted'
    | 'Under Review'
    | 'Verified'
    | 'Assigned'
    | 'In Progress'
    | 'Resolved'
    | 'Rejected'
    | 'Reopened'
    | 'Escalated';
  department_id: string | null;
  department_name?: string;
  officer_id: string | null;
  officer_name?: string;
  sla_deadline: string;
  aiVerification: Record<string, unknown>;
  community_confirmations: number;
  upvotes: number;
  resolution_notes?: string;
  resolution_feedback?: string;
  citizen_rating?: number;
  resolved_at?: string;
  escalated_at?: string;
  distanceKm: number | null;
  isOverdue: boolean;
  activities: CivicActivityItem[];
  created_at: string;
  updated_at: string;
}

export interface AuthorityGrievance {
  id: string;
  grievance_code: string;
  citizen_id?: string;
  citizen_name?: string;
  citizen_email?: string;
  category: string;
  related_report_code: string;
  target_department_id: string;
  department_name?: string;
  target_officer_name?: string;
  title: string;
  description?: string;
  evidenceUrls: string[];
  resolutionEvidenceUrls: string[];
  status: 'Submitted' | 'Under Review' | 'Investigating' | 'Resolved' | 'Dismissed';
  assigned_admin_id?: string;
  resolution_notes: string;
  created_at: string;
  updated_at: string;
  resolved_at?: string;
}

export interface MedicalRequest {
  id: string;
  request_code: string;
  citizen_id: string;
  citizen_name?: string;
  citizen_phone?: string;
  blood_group?: string;
  medical_notes?: string;
  request_type: string;
  urgency: 'normal' | 'urgent' | 'critical';
  description: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  address: string;
  selected_facility_name: string;
  selected_facility_phone: string;
  selected_facility_address: string;
  status: 'Submitted' | 'Acknowledged' | 'Dispatched' | 'Coordinated' | 'Resolved' | 'Cancelled';
  assigned_officer_id: string;
  assigned_officer_name: string;
  responder_notes: string;
  linked_sos_id: string;
  created_at: string;
  updated_at: string;
  resolved_at: string;
}

export interface TransitStop {
  name: string;
  lat: number;
  lng: number;
  waitMin: number;
}

export interface TransitRoute {
  id: string;
  route_code: string;
  name: string;
  origin: string;
  destination: string;
  vehicle_category: 'shared_auto' | 'mini_bus' | 'e_rickshaw';
  geometry: Array<[number, number]>;
  stops: TransitStop[];
  operating_hours: string;
  base_fare_inr: number;
  fare_source: 'verified' | 'estimated' | 'community';
  est_duration_min: number;
  distance_km: number;
  verification_status: 'verified' | 'pending' | 'flagged';
  reliability_score: number;
  delay_reports: number;
}

export interface TransitVehicle {
  id: string;
  reg_number: string;
  driver_id: string;
  driver_name: string;
  route_id: string;
  vehicle_type: string;
  capacity: number;
  available_seats: number;
  status: 'active' | 'idle' | 'maintenance';
  lat: number;
  lng: number;
  is_simulated: number;
  last_updated: string;
}

export type MobilityMode = 'driving' | 'foot' | 'cycling';

export interface MobilityDestinationResult {
  name: string;
  shortName: string;
  lat: number;
  lng: number;
  category: string;
}

export interface MobilityRouteStep {
  instruction: string;
  distanceMeters: number;
  durationSeconds: number;
  roadName: string;
}

export interface MobilityRouteResult {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  mode: MobilityMode;
  distanceKm: number;
  durationMin: number;
  geometry: Array<[number, number]>;
  steps: MobilityRouteStep[];
  source: string;
}

export interface MobilityHub {
  id: string;
  name: string;
  hubType: 'metro_station' | 'bus_station' | 'bus_stop' | 'auto_stand' | 'railway_station';
  address: string;
  lat: number;
  lng: number;
  distanceKm: number;
  source: string;
}

export interface WasteBin {
  id: string;
  bin_code: string;
  ward: string;
  address: string;
  lat: number;
  lng: number;
  capacity_l: number;
  fill_level_pct: number;
  waste_type: string;
  sensor_type: 'ultrasonic' | 'simulated';
  battery_pct: number;
  connectivity: 'online' | 'offline' | 'simulated';
  status: 'normal' | 'nearly_full' | 'overflowing';
  last_collected_at: string;
}

export interface WasteCollection {
  id: string;
  bin_id: string;
  bin_code: string;
  address: string;
  ward: string;
  lat: number;
  lng: number;
  driver_id: string;
  driver_name: string;
  vehicle_code: string;
  scheduled_time: string;
  completed_at: string;
  before_photo: string;
  after_photo: string;
  status: 'scheduled' | 'in_progress' | 'completed' | 'missed';
  notes: string;
}

export interface RecyclingCentre {
  id: string;
  name: string;
  ward: string;
  address: string;
  lat: number;
  lng: number;
  acceptedTypes: string[];
  hours: string;
  contact: string;
}

export interface NotificationItem {
  id: string;
  event_type: string;
  title: string;
  message: string;
  message_hi: string;
  related_id: string;
  is_read: number;
  created_at: string;
}

export interface CitizenSafetyProfile {
  user_id: string;
  blood_group: string;
  medical_notes: string;
  emergency_phone: string;
  home_ward: string;
  updated_at?: string;
}

export interface EmergencyContact {
  id: string;
  user_id: string;
  name: string;
  relationship: string;
  phone: string;
  is_primary: number;
  created_at: string;
}

export interface SafetyZone {
  id: string;
  citizen_id: string;
  name: string;
  zone_type: 'safe_zone' | 'alert_zone';
  lat: number;
  lng: number;
  radius_m: number;
  address: string;
  is_active: number;
  created_at: string;
}

export interface CaregiverRelationship {
  id: string;
  caregiver_name: string;
  caregiver_phone: string;
  status: 'pending_verification' | 'verified_awaiting_approval' | 'active' | 'revoked' | 'disconnected';
  notify_in_app: number;
  notify_sms: number;
  notify_whatsapp: number;
  can_view_location?: number;
  can_receive_sos?: number;
  can_view_profile?: number;
  verified_at?: string;
  created_at: string;
  updated_at: string;
}

export interface CaregiverAccessTokenInfo {
  id: string;
  relationship_id: string;
  expires_at: string;
  revoked_at: string;
  last_accessed_at: string;
  created_at: string;
}

export interface SafetySession {
  id: string;
  citizen_id: string;
  status: 'active' | 'stopped' | 'expired';
  duration_minutes: number;
  started_at: string;
  expires_at: string;
  stopped_at?: string;
  last_lat: number | null;
  last_lng: number | null;
  last_accuracy_m: number | null;
  last_address: string;
  last_location_at: string;
}

export interface SosIncident {
  id: string;
  incident_code: string;
  citizen_id: string;
  safety_session_id: string;
  status: 'active' | 'acknowledged' | 'resolved' | 'cancelled';
  trigger_lat: number | null;
  trigger_lng: number | null;
  trigger_accuracy_m: number | null;
  trigger_address: string;
  location_status: 'live' | 'last_known' | 'unavailable';
  notes: string;
  acknowledged_by?: string;
  assigned_officer_id?: string;
  assigned_officer_name?: string;
  response_notes?: string;
  created_at: string;
  updated_at: string;
  resolved_at: string;
}

export interface CaregiverNotification {
  id: string;
  relationship_id: string;
  citizen_id: string;
  caregiver_name: string;
  caregiver_phone: string;
  event_type:
    | 'sos_activated'
    | 'safety_activated'
    | 'location_sharing_started'
    | 'location_sharing_stopped'
    | 'emergency_updated'
    | 'permission_revoked'
    | 'safety_status_changed';
  title: string;
  message: string;
  sos_incident_id: string;
  in_app_read: number;
  sms_status: 'sent' | 'failed' | 'not_configured' | 'skipped';
  sms_error: string;
  whatsapp_status: 'sent' | 'failed' | 'not_configured' | 'skipped';
  whatsapp_error: string;
  created_at: string;
}

export interface MessagingProviderStatus {
  smsConfigured: boolean;
  whatsappConfigured: boolean;
  providerName: string;
}

export interface SafetyDashboardData {
  profile: CitizenSafetyProfile;
  contacts: EmergencyContact[];
  caregivers: CaregiverRelationship[];
  activeTokens: CaregiverAccessTokenInfo[];
  zones?: SafetyZone[];
  activeSession: SafetySession | null;
  sosIncidents: SosIncident[];
  caregiverNotifications: CaregiverNotification[];
  messagingProvider: MessagingProviderStatus;
}

export type FacilityCategory = 'all' | 'hospital' | 'police' | 'clinic' | 'pharmacy' | 'emergency';

export interface PublicFacility {
  id: string;
  name: string;
  category: Exclude<FacilityCategory, 'all'>;
  lat: number;
  lng: number;
  distanceKm: number;
  address: string;
  phone: string;
  openingHours: string;
  emergencyTag: string;
  source: string;
}

export interface FacilitySearchResult {
  facilities: PublicFacility[];
  source: string;
  cached: boolean;
  fetchedAt: string;
  disclaimer: string;
  error?: string;
}

export interface CaregiverLinkedCitizen {
  relationshipId: string;
  citizenId: string;
  citizenName: string;
  citizenPhone?: string;
  status: string;
  authorized: boolean;
  permissions?: {
    canViewLocation: boolean;
    canReceiveSos: boolean;
    canViewProfile: boolean;
  };
  activeSession?: SafetySession | null;
  sosAlerts?: SosIncident[];
  emergencyProfile?: CitizenSafetyProfile | null;
}

export interface CaregiverPortalData {
  linkedCitizens: CaregiverLinkedCitizen[];
  notifications: CaregiverNotification[];
}

export interface CitizenDashboardSummary {
  reports: {
    total: number;
    pending: number;
    resolved: number;
    recent: Array<{
      id: string;
      report_code: string;
      category: string;
      title: string;
      status: string;
      severity: string;
      address: string;
      updated_at: string;
    }>;
  };
  grievances: {
    total: number;
    open: number;
    recent: Array<{
      id: string;
      grievance_code: string;
      title: string;
      status: string;
      updated_at: string;
    }>;
  };
  medical: {
    total: number;
    active: number;
    recent: Array<{
      id: string;
      request_code: string;
      request_type: string;
      urgency: string;
      status: string;
      selected_facility_name: string;
      updated_at: string;
    }>;
  };
  safety: {
    activeSession: {
      id: string;
      status: string;
      expires_at: string;
      last_address: string;
      last_location_at: string;
    } | null;
    activeSos: {
      id: string;
      incident_code: string;
      status: string;
      trigger_address: string;
      created_at: string;
    } | null;
    verifiedCaregivers: number;
  };
  rewards: {
    points: number;
    badges: string[];
    streakDays: number;
  };
  unreadNotifications: number;
}

export interface RewardsOverviewData {
  points: number;
  streakDays: number;
  householdsVerified: number;
  badges: string[];
  history: Array<{ date: string; action: string; points: number; refId?: string }>;
  verifiedReportsCount: number;
  resolvedReportsCount: number;
  nextTierPoints: number;
  rewardConfig: {
    verifiedReportPoints: number;
    resolutionConfirmedPoints: number;
    segregationPoints: number;
    maxDailyClaims: number;
  };
  leaderboard: Array<{
    user_id: string;
    name: string;
    points: number;
    streak_days: number;
    badges: string[];
    isCurrentUser: boolean;
  }>;
}

export interface AuthorityOverviewData {
  metrics: {
    totalReports: number;
    pendingCount: number;
    verifiedCount: number;
    assignedInProgressCount: number;
    resolvedCount: number;
    rejectedCount: number;
    overdueCount: number;
    escalatedCount: number;
    activeSosCount: number;
    activeMedicalCount: number;
  };
  recentActivity: Array<{
    id: string;
    report_id: string;
    report_code: string;
    report_title: string;
    previous_status: string | null;
    new_status: string;
    actor_name: string;
    actor_role: string;
    comment: string;
    created_at: string;
  }>;
  recentEmergencies: Array<SosIncident & { citizen_name: string; citizen_phone: string }>;
}

export interface AuthoritySosIncident extends SosIncident {
  citizen_name: string;
  citizen_phone: string;
  blood_group?: string;
  medical_notes?: string;
  caregivers: Array<{ caregiver_name: string; caregiver_phone: string; status: string }>;
}

export interface AuthorityPerformanceData {
  departmentMetrics: Array<{
    id: string;
    name: string;
    code: string;
    sla_hours: number;
    head_name: string;
    totalAssigned: number;
    resolvedCount: number;
    pendingCount: number;
    overdueCount: number;
    resolutionRatePct: number;
    avgResolutionHours: number;
  }>;
  officerLeaderboard: Array<{
    id: string;
    user_id: string;
    department_id: string;
    department_name: string;
    name: string;
    badge_no: string;
    ward: string;
    assignedTotal: number;
    resolvedTotal: number;
    overdueTotal: number;
    slaCompliancePct: number;
    performanceScore: number;
  }>;
}

export interface AdminOverviewData {
  totalUsers: number;
  totalReports: number;
  totalOfficers: number;
  activeSosCount: number;
  totalGrievances: number;
  openGrievances: number;
  totalMedicalRequests: number;
  activeMedicalRequests: number;
  usersByRole: Array<{ role: string; count: number }>;
  reportsByStatus: Array<{ status: string; count: number }>;
  recentUsers: Array<{
    id: string;
    name: string;
    email: string;
    phone: string;
    role: UserRole;
    department_id: string;
    account_status: string;
    auth_provider?: string;
    last_login_at?: string;
    created_at: string;
  }>;
  departments: Array<{
    id: string;
    name: string;
    code: string;
    sla_hours: number;
    head_name: string;
    is_active?: number;
  }>;
  officers: Array<{
    id: string;
    user_id: string;
    department_id: string;
    department_name: string;
    name: string;
    badge_no: string;
    ward: string;
    account_email?: string;
    account_status?: string;
  }>;
  slaRules: Array<{
    id: string;
    category: string;
    department_id: string;
    department_name: string;
    sla_hours: number;
    escalation_hours: number;
  }>;
  caregiverLinks: Array<
    CaregiverRelationship & {
      citizen_id: string;
      citizen_name: string;
      citizen_email: string;
    }
  >;
  grievances: AuthorityGrievance[];
  medicalRequests: MedicalRequest[];
  smsLogs: Array<{
    id: string;
    event_type: string;
    caregiver_phone: string;
    sms_status: string;
    sms_error: string;
    whatsapp_status: string;
    created_at: string;
  }>;
  auditLogs: Array<{
    id: string;
    actor_id: string;
    actor_role: string;
    action: string;
    target_type: string;
    target_id: string;
    metadata_json: string;
    created_at: string;
  }>;
  rewardConfig: {
    verifiedReportPoints: number;
    resolutionConfirmedPoints: number;
    segregationPoints: number;
    maxDailyClaims: number;
  };
  securitySettings: {
    sessionTtlHours: number;
    allowCitizenGoogleSignup: boolean;
    allowCaregiverGoogleSignup: boolean;
  };
  messagingProvider: MessagingProviderStatus;
  geminiConfigured: boolean;
  elevenLabsConfigured: boolean;
  googleOAuth: {
    configured: boolean;
    clientIdPresent: boolean;
    clientSecretPresent: boolean;
    superAdminEmailConfigured: boolean;
  };
}
