import {
  ArrowLeft,
  BookOpen,
  Box,
  Braces,
  CalendarDays,
  Check,
  Copy,
  CreditCard,
  FileText,
  KeyRound,
  Loader2,
  LogOut,
  LockKeyhole,
  Mail,
  Menu,
  Phone,
  Plus,
  Search,
  Server,
  ShoppingCart,
  Sparkles,
  Target,
  Zap,
  X
} from "lucide-react";
import { motion, useScroll, useTransform, type MotionStyle, type MotionValue, type Variants } from "framer-motion";
import React, { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ToastNotifications,
  type ToastNotification,
  type ToastNotificationInput
} from "./components/ToastNotifications";
import { PaymentsPanel } from "./components/PaymentsPanel";
import { EmailPanel } from "./components/EmailPanel";
import { PhonePanel } from "./components/PhonePanel";
import {
  api,
  type DashboardChatCallEmbed,
  type DashboardChatMessageInput,
  type Site,
  type SiteApiKey,
  type SiteDetailResponse,
  type User
} from "./api";
import aidentityMarkDark from "./assets/aidentity/brand/aidentity-mark-dark.svg";
import aidentityMarkLight from "./assets/aidentity/brand/aidentity-mark-light.svg";
import sitePreviewBlueFlow from "./assets/aidentity/images/site-preview-blue-flow.webp";
import sitePreviewCoralMint from "./assets/aidentity/images/site-preview-coral-mint.webp";
import sitePreviewCyanMist from "./assets/aidentity/images/site-preview-cyan-mist.webp";
import sitePreviewDashboard from "./assets/aidentity/images/site-preview-dashboard.webp";
import sitePreviewLimeBlue from "./assets/aidentity/images/site-preview-lime-blue.webp";
import sitePreviewLimeViolet from "./assets/aidentity/images/site-preview-lime-violet.webp";

const dashboardPath = "/dashboard";
const dashboardChatPath = `${dashboardPath}/chat`;
const userSettingsPath = `${dashboardPath}/settings`;
const newSitePath = "/new-site";
const signinPath = "/signin";
const plansPath = "/plans";
const profileAvatarMaxBytes = 256 * 1024;
const profileAvatarAcceptedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

type AuthMode = "login" | "signup";
type AuthStep = "email" | "password";
type SiteOnboardingStep = "name" | "openclaw" | "setup" | "install" | "finish";
type OpenClawConnectionMode = "existing" | "deploy";
type DashboardSection = "sites" | "chat" | "settings";
type DashboardChatRole = "assistant" | "user";
type DashboardChatMessage = {
  id: string;
  role: DashboardChatRole;
  content: string;
  presentation?: "normal" | "activity";
  callEmbed?: DashboardChatCallEmbed & { state: "in_progress" | "completed" };
  clarificationDetails?: {
    entries: Array<{ question: string; answer: string }>;
  };
};
type SiteDetailTab = "credentials" | "openclaw" | "phone" | "payments" | "email";
type UserSettingsSection = "profile" | "security" | "notifications" | "billing";
type PanelState = "active" | "hidden" | "incoming" | "outgoing";
type SetupProgressStep = "connection";
type SetupStepProgress = Partial<Record<SetupProgressStep, { current: number; total: number; label?: string }>>;
type StepTransition = {
  from: SiteOnboardingStep;
  to: SiteOnboardingStep;
};
type AuthTransition = {
  from: AuthStep;
  to: AuthStep;
};

const siteProgressSteps = [0, 1, 2, 3, 4];
const siteStepIndexes: Record<SiteOnboardingStep, number> = {
  name: 0,
  openclaw: 1,
  setup: 2,
  install: 3,
  finish: 4
};
const panelTransitionDurationMs = 560;
const onboardingPanelTransitionDurationMs = 820;
const onboardingPanelTransitionSwapMs = 300;
const buttonLoadingDurationMs = 420;
const requiredFieldMessage = "Please fill in this field.";
const onboardingSetupSteps: Array<{ id: SetupProgressStep; label: string }> = [
  { id: "connection", label: "OpenClaw link" }
];

function isCompletionOnboardingStep(step: SiteOnboardingStep) {
  return step === "setup" || step === "install" || step === "finish";
}
const sitePreviewImages = {
  "site-preview-blue-flow": sitePreviewBlueFlow,
  "site-preview-coral-mint": sitePreviewCoralMint,
  "site-preview-cyan-mist": sitePreviewCyanMist,
  "site-preview-dashboard": sitePreviewDashboard,
  "site-preview-lime-blue": sitePreviewLimeBlue
} as const;
const sitePreviewImageNames = Object.keys(sitePreviewImages) as Array<keyof typeof sitePreviewImages>;
const agentIdentityCapabilities = [
  {
    label: "Phone",
    value: "+1 (415) 555-0198",
    description: "Calls and SMS for the agent",
    Icon: Phone
  },
  {
    label: "Email",
    value: "agent@aidentity.space",
    description: "Inbox and outbound email identity",
    Icon: Mail
  },
  {
    label: "Card",
    value: "Visa •••• 4242",
    description: "Auto-approves under £25, human approval above",
    Icon: CreditCard
  },
  {
    label: "Calendar",
    value: "Managed calendar",
    description: "Availability and scheduling",
    Icon: CalendarDays
  },
  {
    label: "Amazon",
    value: "agent@aidentity.space",
    description: "Its own Amazon account for autonomous purchases",
    Icon: ShoppingCart
  }
] as const;

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

function isTimeoutLikeSetupError(message: string): boolean {
  const normalizedMessage = message.trim().toLowerCase();
  return normalizedMessage === "failed to fetch" || normalizedMessage.includes("time");
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

function slugifyIdentityName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "agent";
}

function buildOpenClawLinkPrompt(identityName: string, token: string | undefined, projectId: string | null): string {
  const linkEndpoint = `${window.location.origin}/api/openclaw/link/confirm`;
  const safeToken = token ?? "LINK_TOKEN_PENDING";
  const safeProjectId = projectId ?? "PROJECT_ID_PENDING";

  return `Install the Aidentity Agent Identity skill for this OpenClaw instance.

Identity name: ${identityName.trim() || "New agent identity"}
Link endpoint: ${linkEndpoint}
Project token: ${safeProjectId}
Confirmation token: ${safeToken}

After installing the skill, call the link endpoint with the confirmation token so Aidentity can attach this OpenClaw instance to the identity. Once linked, use the provisioned phone number, email inbox, payment card, calendar, and future real-world tools through the Aidentity identity layer.`;
}

function buildIdentityReceipt(site: Site | null): string {
  const identityName = site?.name ?? "Agent identity";
  const endpoint = site?.domain ?? "managed-openclaw.aidentity.space";

  return `Aidentity Agent Identity
name=${identityName}
openclaw=${endpoint}
phone=+1-415-555-0198
email=agent@aidentity.space
card=visa_4242
calendar=managed
amazon=agent@aidentity.space`;
}

function isAppRoute(path: string): boolean {
  return isProtectedAppRoute(path) || isSigninRoute(path);
}

function isProtectedAppRoute(path: string): boolean {
  return (
    isDashboardRoute(path) ||
    isDashboardChatRoute(path) ||
    isUserSettingsRoute(path) ||
    isNewSiteRoute(path) ||
    getSiteDetailRoute(path) !== null
  );
}

function isDashboardRoute(path: string): boolean {
  return path === dashboardPath || path === `${dashboardPath}/`;
}

function isDashboardChatRoute(path: string): boolean {
  return path === dashboardChatPath || path === `${dashboardChatPath}/`;
}

function isUserSettingsRoute(path: string): boolean {
  return path === userSettingsPath || path === `${userSettingsPath}/`;
}

function isNewSiteRoute(path: string): boolean {
  return path === newSitePath || path === `${newSitePath}/`;
}

function isSigninRoute(path: string): boolean {
  return path === signinPath || path === `${signinPath}/`;
}

function isPlansRoute(path: string): boolean {
  return path === plansPath || path === `${plansPath}/`;
}

function getSiteDetailPath(siteId: string, tab: SiteDetailTab = "credentials"): string {
  return `${dashboardPath}/site/${encodeURIComponent(siteId)}?tab=${tab}`;
}

function getUserSettingsPath(section: UserSettingsSection = "profile"): string {
  return `${userSettingsPath}?section=${section}`;
}

function getCurrentLocation(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function navigateToPublicHome() {
  if (import.meta.env.MODE === "test") {
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    return;
  }

  window.location.assign("/");
}

function getSiteDetailRoute(path: string, search = ""): { siteId: string; tab: SiteDetailTab } | null {
  const match = /^\/dashboard\/site\/([^/]+)\/?$/.exec(path);
  if (!match) {
    return null;
  }

  const rawTab = new URLSearchParams(search).get("tab");
  const tab =
    rawTab === "openclaw" ||
    rawTab === "phone" ||
    rawTab === "payments" ||
    rawTab === "email"
      ? rawTab
      : "credentials";

  try {
    return {
      siteId: decodeURIComponent(match[1]),
      tab
    };
  } catch {
    return null;
  }
}

function getUserSettingsSection(path: string, search = ""): UserSettingsSection {
  if (!isUserSettingsRoute(path)) {
    return "profile";
  }

  const rawSection = new URLSearchParams(search).get("section");
  if (rawSection === "security" || rawSection === "notifications" || rawSection === "billing") {
    return rawSection;
  }

  return "profile";
}

function getStaggerStyle(index: number): CSSProperties {
  return { "--stagger-index": index } as CSSProperties;
}

function getProjectCardStyle(index: number): CSSProperties {
  return { "--project-index": index } as CSSProperties;
}

function getSitePreviewImage(site: Site): string {
  if (site.previewImage && site.previewImage in sitePreviewImages) {
    return sitePreviewImages[site.previewImage as keyof typeof sitePreviewImages];
  }

  let hash = 0;
  for (const character of site.id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return sitePreviewImages[sitePreviewImageNames[hash % sitePreviewImageNames.length] ?? "site-preview-dashboard"];
}

function formatSiteRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return "Recently updated";
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) {
    return "Updated just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `Updated ${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `Updated ${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `Updated ${elapsedDays}d ago`;
}

export function App() {
  const [currentLocation, setCurrentLocation] = useState(getCurrentLocation);
  const [user, setUser] = useState<User | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedApiKeys, setSelectedApiKeys] = useState<SiteApiKey[]>([]);
  const [notifications, setNotifications] = useState<ToastNotification[]>([]);
  const notificationIdRef = useRef(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [currentPath, currentSearch] = useMemo(() => {
    const [path, search = ""] = currentLocation.split("?", 2);
    return [path, search ? `?${search}` : ""];
  }, [currentLocation]);
  const siteDetailRoute = useMemo(() => getSiteDetailRoute(currentPath, currentSearch), [currentPath, currentSearch]);
  const selectedSiteId = siteDetailRoute?.siteId ?? null;
  const activeSiteDetailTab = siteDetailRoute?.tab ?? "credentials";
  const activeUserSettingsSection = useMemo(
    () => getUserSettingsSection(currentPath, currentSearch),
    [currentPath, currentSearch]
  );
  const isCreatingSite = isNewSiteRoute(currentPath);
  const activeDashboardSection: DashboardSection = isUserSettingsRoute(currentPath)
    ? "settings"
    : isDashboardChatRoute(currentPath)
      ? "chat"
      : "sites";

  useEffect(() => {
    const handleNavigation = () => setCurrentLocation(getCurrentLocation());
    window.addEventListener("popstate", handleNavigation);

    return () => window.removeEventListener("popstate", handleNavigation);
  }, []);

  useEffect(() => {
    if (!isAppRoute(currentPath)) {
      return;
    }

    if (user && isProtectedAppRoute(currentPath)) {
      return;
    }

    void bootstrap(currentPath);
  }, [currentPath, user]);

  useEffect(() => {
    if (isSigninRoute(currentPath) && user) {
      replacePath(dashboardPath);
    }
  }, [currentPath, user]);

  const selectedSite = useMemo(
    () => sites.find((site) => site.id === selectedSiteId) ?? null,
    [selectedSiteId, sites]
  );
  useEffect(() => {
    if (selectedSite) {
      void loadSiteDetail(selectedSite.id);
    } else {
      setSelectedApiKeys([]);
    }
  }, [selectedSite?.id]);

  async function bootstrap(path: string) {
    if (api.hasForcedLogout()) {
      void api.logout().catch(() => undefined);
      setUser(null);
      if (isProtectedAppRoute(path)) {
        replacePath(signinPath);
      }
      setIsLoading(false);
      return;
    }

    try {
      const response = await api.me();
      setUser(response.user);
      await refreshSites();
    } catch {
      setUser(null);
      if (isProtectedAppRoute(path)) {
        replacePath(signinPath);
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshSites() {
    const response = await api.listSites();
    setSites(response.sites);
    return response.sites;
  }

  async function loadSiteDetail(siteId: string) {
    try {
      const response = await api.getSite(siteId);
      applySiteDetailResponse(response);
      setError("");
    } catch (siteError) {
      setError(getErrorMessage(siteError, "Could not load site"));
    }
  }

  function applySiteDetailResponse(response: SiteDetailResponse) {
    setSites((currentSites) =>
      currentSites.map((currentSite) => (currentSite.id === response.site.id ? response.site : currentSite))
    );
    setSelectedApiKeys(response.apiKeys);
  }

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // Keep sign-out available even if a dev proxy or backend process is stale.
    } finally {
      api.markForcedLogout();
      setUser(null);
      setSites([]);
      setSelectedApiKeys([]);
      navigateToPublicHome();
    }
  }

  function pushPath(nextPath: string) {
    if (getCurrentLocation() === nextPath) {
      setCurrentLocation(getCurrentLocation());
      return;
    }

    window.history.pushState({}, "", nextPath);
    setCurrentLocation(getCurrentLocation());
  }

  function replacePath(nextPath: string) {
    if (getCurrentLocation() === nextPath) {
      setCurrentLocation(getCurrentLocation());
      return;
    }

    window.history.replaceState({}, "", nextPath);
    setCurrentLocation(getCurrentLocation());
  }

  async function handleSiteCreated(detail: SiteDetailResponse) {
    const refreshedSites = await refreshSites();
    if (!refreshedSites.some((site) => site.id === detail.site.id)) {
      setSites([detail.site, ...refreshedSites]);
    }
    setSelectedApiKeys([]);
    replacePath(dashboardPath);
  }

  function handleSiteUpdated(site: Site) {
    setSites((currentSites) => currentSites.map((currentSite) => (currentSite.id === site.id ? site : currentSite)));
  }

  function dismissNotification(notificationId: string) {
    setNotifications((currentNotifications) =>
      currentNotifications.filter((notification) => notification.id !== notificationId)
    );
  }

  function showNotification(notification: ToastNotificationInput) {
    const { durationMs = 3600, kind = "success", ...notificationContent } = notification;
    const id = `toast-${Date.now()}-${notificationIdRef.current++}`;

    setNotifications((currentNotifications) => [
      ...currentNotifications.slice(-2),
      {
        id,
        kind,
        ...notificationContent
      }
    ]);

    window.setTimeout(() => dismissNotification(id), durationMs);
  }

  function handleSiteDeleted(siteId: string) {
    setSites((currentSites) => currentSites.filter((site) => site.id !== siteId));
    setSelectedApiKeys([]);
    replacePath(dashboardPath);
  }

  if (isPlansRoute(currentPath)) {
    return <PricingPage />;
  }

  if (!isAppRoute(currentPath)) {
    return <LandingPage />;
  }

  if (isLoading) {
    return (
      <main className="aidentity-loading" aria-label="Loading Aidentity">
        <Loader2 className="aidentity-loading__spinner" aria-hidden="true" />
      </main>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        key={currentLocation}
        onAuthed={(nextUser) => setUser(nextUser)}
        onReady={async () => {
          await refreshSites();
          if (isSigninRoute(currentPath)) {
            replacePath(dashboardPath);
          }
        }}
      />
    );
  }

  if (isCreatingSite) {
    return (
      <>
        <SiteOnboardingScreen
          onCancel={() => replacePath(dashboardPath)}
          onCreated={handleSiteCreated}
        />
        <ToastNotifications notifications={notifications} />
      </>
    );
  }

  return (
    <>
      <DashboardScreen
        error={error}
        user={user}
        sites={sites}
        selectedSite={selectedSite}
        activeSection={activeDashboardSection}
        activeSiteDetailTab={activeSiteDetailTab}
        activeUserSettingsSection={activeUserSettingsSection}
        selectedApiKeys={selectedApiKeys}
        onCreateSite={() => pushPath(newSitePath)}
        onLogout={handleLogout}
        onSelectSite={(siteId) => pushPath(getSiteDetailPath(siteId, "credentials"))}
        onOpenDashboard={() => replacePath(dashboardPath)}
        onOpenDashboardChat={() => replacePath(dashboardChatPath)}
        onOpenProfileSettings={() => replacePath(getUserSettingsPath("profile"))}
        onUserSettingsSectionChange={(section) => pushPath(getUserSettingsPath(section))}
        onUserUpdated={setUser}
        onSiteDetailTabChange={(siteId, tab) => pushPath(getSiteDetailPath(siteId, tab))}
        onApiKeyCreated={(apiKey) => setSelectedApiKeys((currentApiKeys) => [apiKey, ...currentApiKeys])}
        onApiKeyDeleted={(apiKeyId) =>
          setSelectedApiKeys((currentApiKeys) => currentApiKeys.filter((apiKey) => apiKey.id !== apiKeyId))
        }
        onSiteDetailLoaded={applySiteDetailResponse}
        onSiteUpdated={handleSiteUpdated}
        onSiteDeleted={handleSiteDeleted}
        onNotify={showNotification}
        onCloseDetail={() => {
          setSelectedApiKeys([]);
          replacePath(dashboardPath);
        }}
      />
      <ToastNotifications notifications={notifications} />
    </>
  );
}

const heroTitleLines = [
  ["Turn", "your", "SaaS", "into", "an", "AI-native"],
  ["product."]
];

const pricingTitleLines = [
  ["Pricing", "that", "scales"],
  ["with", "your", "company."]
];

const heroTitleContainerVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.055,
      delayChildren: 0.12
    }
  }
};

const heroTitleWordVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 28,
    filter: "blur(14px)"
  },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: {
      duration: 0.78,
      ease: [0.22, 1, 0.36, 1]
    }
  }
};

const landingFeatureCards = [
  {
    title: "Real-world agent identity",
    description:
      "Give each AI worker a durable identity with a phone number, inbox, payment rail, calendar, and policy controls your team can audit.",
    image: sitePreviewCyanMist,
    imageAlt: "Blurred product landscape preview",
    imagePosition: "left"
  },
  {
    title: "OpenClaw runtime linking",
    description:
      "Link an identity to an OpenClaw runtime so the agent can operate with scoped credentials, clear ownership, and current tool state.",
    image: sitePreviewCoralMint,
    imageAlt: "Blurred workflow landscape preview",
    imagePosition: "right"
  },
  {
    title: "Operational tool surface",
    description:
      "Simulate, review, and provision calls, email, payments, and scheduling from the dashboard before wiring an agent into production.",
    image: sitePreviewLimeBlue,
    imageAlt: "Blurred automation landscape preview",
    imagePosition: "left"
  }
] as const;

const landingBenefitCards = [
  {
    title: "Identity-first controls",
    description: "Manage the real-world capabilities an agent can use from a dedicated identity and operations dashboard.",
    Icon: Target
  },
  {
    title: "OpenClaw ready",
    description: "Create link tokens for existing OpenClaw instances or prepare a managed setup from the same onboarding flow.",
    Icon: Box
  },
  {
    title: "Your runtime stays yours",
    description: "Keep agent execution in your chosen infrastructure while Aidentity manages the identity and operational tool layer.",
    Icon: LockKeyhole
  },
  {
    title: "Dashboard simulation",
    description: "Use the dashboard chat and tool panels to test how an identity handles calls, email, payments, and scheduling.",
    Icon: Zap
  },
  {
    title: "Policy-shaped actions",
    description: "Keep sensitive capabilities visible and bounded, from payment thresholds to communication identities.",
    Icon: Braces
  },
  {
    title: "Agent operations hub",
    description: "Bring identity setup, OpenClaw linking, credentials, and real-world tool status into one focused dashboard.",
    Icon: Sparkles
  }
] as const;

const pricingPlans = [
  {
    name: "Launch",
    price: "$300",
    priceNote: "per month, depending on usage",
    description: "For early teams giving one agent identity real-world communication and payment tools.",
    features: ["1 agent identity", "Typical usage for a small customer base", "Dashboard chat and phone assistance", "OpenClaw identity linking"],
    isRecommended: false
  },
  {
    name: "Growth",
    price: "$900",
    priceNote: "per month, depending on usage",
    description: "For growing teams managing multiple agent identities and operational tool surfaces.",
    features: ["Multiple agent identities", "Higher tool usage volume", "Phone, email, and payment tools", "Priority identity support"],
    isRecommended: true
  },
  {
    name: "Enterprise",
    price: "Custom",
    priceNote: "based on volume, integrations, and support needs",
    description: "For teams rolling Aidentity identities across larger operations and custom agent runtimes.",
    features: ["Volume-based usage planning", "Custom integrations and rollout help", "Dedicated support path", "Advanced workflow coverage"],
    isRecommended: false
  }
] as const;

const pricingComparisonRows = [
  { feature: "Agent identities", launch: "1 identity", growth: "Multiple identities", enterprise: "Custom rollout" },
  { feature: "Assisted sessions", launch: "Small-business usage", growth: "Growing product usage", enterprise: "Volume planning" },
  { feature: "Real-world tools", launch: "Core tools", growth: "Expanded tool coverage", enterprise: "Custom tool scope" },
  { feature: "OpenClaw setup", launch: "Prompt-based link", growth: "Managed support", enterprise: "Custom runtime support" },
  { feature: "Support", launch: "Standard support", growth: "Priority support", enterprise: "Dedicated support path" },
  { feature: "Integrations", launch: "Standard identity setup", growth: "Runtime guidance", enterprise: "Custom integrations" }
] as const;

const pricingFaqItems = [
  {
    question: "Why does pricing depend on usage?",
    answer:
      "Aidentity usage depends on how many identities you run, how often voice and email are used, and how many real-world tool events the agent triggers."
  },
  {
    question: "What counts as usage?",
    answer:
      "Typical usage includes dashboard chat, phone calls, email sends, payment requests, and the scale of connected agent identities."
  },
  {
    question: "How long does setup take?",
    answer:
      "Most teams start by creating an agent identity, linking OpenClaw, and testing phone, email, and payment tools from the dashboard."
  },
  {
    question: "Can we switch plans later?",
    answer:
      "Yes. The first version of this page is presentational, but the pricing model is meant to flex as your product usage grows."
  },
  {
    question: "What does Enterprise include?",
    answer:
      "Enterprise is for higher volume, deeper integrations, and teams that need more support during rollout and workflow expansion."
  }
] as const;

const landingBenefitsContainerVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.09,
      delayChildren: 0.08
    }
  }
};

const landingBenefitCardVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 28,
    filter: "blur(10px)"
  },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: {
      duration: 0.66,
      ease: [0.22, 1, 0.36, 1]
    }
  }
};

const pricingSubtitleRevealDelay = 0.68;
const pricingCardsRevealDelay = 0.97;

const pricingHeroVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.12,
      delayChildren: 0.08
    }
  }
};

const pricingPlansContainerVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.09,
      delayChildren: pricingCardsRevealDelay
    }
  }
};

const pricingTextRevealVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 22,
    filter: "blur(10px)"
  },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: {
      duration: 0.72,
      ease: [0.22, 1, 0.36, 1]
    }
  }
};

const pricingStaggerContainerVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.09,
      delayChildren: 0.12
    }
  }
};

const pricingCardVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 34,
    scale: 0.985,
    filter: "blur(12px)"
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: {
      duration: 0.72,
      ease: [0.22, 1, 0.36, 1]
    }
  }
};

const pricingFeatureItemVariants: Variants = {
  hidden: {
    opacity: 0,
    x: -10
  },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      duration: 0.42,
      ease: [0.22, 1, 0.36, 1]
    }
  }
};

const stackCardOffsetY = 18;
const stackCardScaleStep = 0.014;
const stackProgressOffset: ["start 522px", "start 127px"] = ["start 522px", "start 127px"];

function easeStackProgress(value: number): number {
  const clampedValue = Math.min(1, Math.max(0, value));
  const x1 = 0.22;
  const y1 = 1;
  const x2 = 0.36;
  const y2 = 1;
  let t = clampedValue;

  for (let iteration = 0; iteration < 5; iteration += 1) {
    const x = cubicBezierValue(t, x1, x2) - clampedValue;
    const derivative = cubicBezierDerivative(t, x1, x2);
    if (Math.abs(derivative) < 0.001) {
      break;
    }

    t = Math.min(1, Math.max(0, t - x / derivative));
  }

  return cubicBezierValue(t, y1, y2);
}

function getStackReactionProgress(value: number): number {
  if (value <= 0.5) {
    return 0;
  }

  const reactionProgress = (value - 0.5) * 2;
  return reactionProgress * easeStackProgress(reactionProgress);
}

function cubicBezierValue(t: number, point1: number, point2: number): number {
  const inverseT = 1 - t;
  return 3 * inverseT * inverseT * t * point1 + 3 * inverseT * t * t * point2 + t * t * t;
}

function cubicBezierDerivative(t: number, point1: number, point2: number): number {
  const inverseT = 1 - t;
  return 3 * inverseT * inverseT * point1 + 6 * inverseT * t * (point2 - point1) + 3 * t * t * (1 - point2);
}

function LandingPage() {
  useEffect(() => {
    navigateToPublicHome();
  }, []);

  return (
    <main className="aidentity-loading" aria-label="Loading Aidentity homepage">
      <Loader2 className="aidentity-loading__spinner" aria-hidden="true" />
    </main>
  );
}

function PricingPage() {
  return (
    <main className="pricing-page">
      <PublicSiteNav page="pricing" />

      <motion.section
        className="pricing-page__hero"
        aria-labelledby="pricingHeroTitle"
      >
        <AnimatedPricingTitle />
        <motion.p
          className="pricing-page__subtitle"
          initial={{ opacity: 0, y: 16, filter: "blur(8px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{
            duration: 0.72,
            delay: pricingSubtitleRevealDelay,
            ease: [0.22, 1, 0.36, 1]
          }}
        >
          Start with AI product guidance, then expand into voice, action execution, and deeper workflow automation as
          your users grow.
        </motion.p>
      </motion.section>

      <motion.section
        className="pricing-page__plans"
        aria-label="Pricing plans"
        variants={pricingPlansContainerVariants}
        initial="hidden"
        animate="visible"
      >
        {pricingPlans.map((plan) => (
          <motion.article
            className={`pricing-page__plan${plan.isRecommended ? " pricing-page__plan--recommended" : ""}`}
            key={plan.name}
            variants={pricingCardVariants}
          >
            {plan.isRecommended ? <span className="pricing-page__plan-badge">Recommended</span> : null}
            <h2>{plan.name}</h2>
            <p className="pricing-page__plan-description">{plan.description}</p>
            <div className="pricing-page__price">
              <span>{plan.price}</span>
              <small>{plan.priceNote}</small>
            </div>
            <a className="pricing-page__plan-cta" href={signinPath}>
              Get started
            </a>
            <motion.ul
              className="pricing-page__feature-list"
              variants={pricingStaggerContainerVariants}
              initial="hidden"
              animate="visible"
            >
              {plan.features.map((feature) => (
                <motion.li key={feature} variants={pricingFeatureItemVariants}>
                  <Check size={17} strokeWidth={2.4} aria-hidden="true" />
                  <span>{feature}</span>
                </motion.li>
              ))}
            </motion.ul>
          </motion.article>
        ))}
      </motion.section>

      <section className="pricing-page__comparison" aria-labelledby="pricingComparisonTitle">
        <motion.div
          className="pricing-page__section-header"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.4 }}
          variants={pricingHeroVariants}
        >
          <motion.p className="landing-page__section-kicker" variants={pricingTextRevealVariants}>
            // Compare plans
          </motion.p>
          <motion.h2 id="pricingComparisonTitle" variants={pricingTextRevealVariants}>
            Choose the right starting point.
          </motion.h2>
        </motion.div>
        <motion.div
          className="pricing-page__comparison-table"
          role="table"
          aria-label="Pricing plan comparison"
          variants={pricingStaggerContainerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.18 }}
        >
          <motion.div
            className="pricing-page__comparison-row pricing-page__comparison-row--header"
            role="row"
            variants={pricingCardVariants}
          >
            <span role="columnheader">Feature</span>
            <span role="columnheader">Launch</span>
            <span role="columnheader">Growth</span>
            <span role="columnheader">Enterprise</span>
          </motion.div>
          {pricingComparisonRows.map((row) => (
            <motion.div className="pricing-page__comparison-row" role="row" key={row.feature} variants={pricingCardVariants}>
              <span role="cell">{row.feature}</span>
              <span role="cell">{row.launch}</span>
              <span role="cell">{row.growth}</span>
              <span role="cell">{row.enterprise}</span>
            </motion.div>
          ))}
        </motion.div>
      </section>

      <section className="pricing-page__faq" id="faq" aria-labelledby="pricingFaqTitle">
        <motion.div
          className="pricing-page__section-header"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.4 }}
          variants={pricingHeroVariants}
        >
          <motion.p className="landing-page__section-kicker" variants={pricingTextRevealVariants}>
            // FAQ
          </motion.p>
          <motion.h2 id="pricingFaqTitle" variants={pricingTextRevealVariants}>
            Founder-friendly answers.
          </motion.h2>
        </motion.div>
        <motion.div
          className="pricing-page__faq-list"
          variants={pricingStaggerContainerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.18 }}
        >
          {pricingFaqItems.map((item) => (
            <motion.article className="pricing-page__faq-item" key={item.question} variants={pricingCardVariants}>
              <h3>{item.question}</h3>
              <p>{item.answer}</p>
            </motion.article>
          ))}
        </motion.div>
      </section>

      <PublicSiteFooter />
    </main>
  );
}

function PublicSiteNav({ page }: { page: "landing" | "pricing" }) {
  const menuId = useId();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const closeMenu = () => setIsMenuOpen(false);

  return (
    <header className="landing-page__nav" aria-label="Aidentity navigation">
      <a className="landing-page__brand" href="/" onClick={closeMenu}>
        <img className="landing-page__brand-mark" src={aidentityMarkLight} alt="" aria-hidden="true" />
        <span>Aidentity</span>
      </a>
      <button
        className="landing-page__menu-button"
        type="button"
        aria-controls={menuId}
        aria-expanded={isMenuOpen}
        aria-label={isMenuOpen ? "Close navigation menu" : "Open navigation menu"}
        onClick={() => setIsMenuOpen((currentValue) => !currentValue)}
      >
        {isMenuOpen ? (
          <X aria-hidden="true" size={22} strokeWidth={2} />
        ) : (
          <Menu aria-hidden="true" size={22} strokeWidth={2} />
        )}
      </button>
      <nav
        id={menuId}
        className={`landing-page__links${isMenuOpen ? " landing-page__links--open" : ""}`}
        aria-label="Landing page sections"
      >
        <a href="/" aria-current={page === "landing" ? "page" : undefined} onClick={closeMenu}>
          Features
        </a>
        <a href={plansPath} aria-current={page === "pricing" ? "page" : undefined} onClick={closeMenu}>
          Plans
        </a>
      </nav>
    </header>
  );
}

function PublicSiteFooter() {
  return (
    <footer className="public-site-footer" aria-label="Aidentity footer">
      <svg
        className="public-site-footer__wordmark"
        viewBox="0 0 100 16"
        preserveAspectRatio="none"
        focusable="false"
      >
        <text x="50" y="15" textAnchor="middle" textLength="100" lengthAdjust="spacingAndGlyphs">
          AIDENTITY
        </text>
      </svg>
    </footer>
  );
}

function LandingFeatureCards() {
  const cardRefs = useMemo(
    () => landingFeatureCards.map(() => React.createRef<HTMLElement>()),
    []
  );

  return (
    <section className="landing-page__features" id="features" aria-labelledby="landingFeaturesTitle">
      <p className="landing-page__section-kicker">// How Aidentity works</p>
      <div className="landing-page__feature-stack">
        {landingFeatureCards.map((card, index) => (
          <LandingFeatureCard
            card={card}
            cardRef={cardRefs[index]}
            index={index}
            key={card.title}
            laterCardRefs={cardRefs.slice(index + 1)}
          />
        ))}
      </div>
      <LandingBenefits />
    </section>
  );
}

function LandingBenefits() {
  return (
    <section className="landing-page__benefits" aria-labelledby="landingBenefitsTitle">
      <motion.div
        className="landing-page__benefits-header"
        initial={{ opacity: 0, y: 18, filter: "blur(8px)" }}
        whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.64, ease: [0.22, 1, 0.36, 1] }}
        viewport={{ once: true, amount: 0.42 }}
      >
        <p className="landing-page__section-kicker">// Benefits</p>
        <h2 className="landing-page__benefits-title" id="landingBenefitsTitle">
          Give every agent a real-world operating identity.
        </h2>
      </motion.div>

      <motion.div
        className="landing-page__benefits-grid"
        variants={landingBenefitsContainerVariants}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.18 }}
      >
        {landingBenefitCards.map(({ title, description, Icon }) => (
          <motion.article className="landing-page__benefit-card" variants={landingBenefitCardVariants} key={title}>
            <span className="landing-page__benefit-icon" aria-hidden="true">
              <Icon size={22} strokeWidth={2.1} />
            </span>
            <h3 className="landing-page__benefit-title">{title}</h3>
            <p className="landing-page__benefit-description">{description}</p>
          </motion.article>
        ))}
      </motion.div>
    </section>
  );
}

function LandingFeatureCard({
  card,
  cardRef,
  index,
  laterCardRefs
}: {
  card: (typeof landingFeatureCards)[number];
  cardRef: React.RefObject<HTMLElement>;
  index: number;
  laterCardRefs: Array<React.RefObject<HTMLElement>>;
}) {
  const firstIncomingProgress = useIncomingCardProgress(laterCardRefs[0]);
  const secondIncomingProgress = useIncomingCardProgress(laterCardRefs[1]);
  const stackY = useStackY(firstIncomingProgress, secondIncomingProgress);
  const stackScale = useStackScale(firstIncomingProgress, secondIncomingProgress);
  const cardStyle = {
    "--feature-card-index": index,
    y: stackY,
    scale: stackScale
  } as unknown as MotionStyle & CSSProperties;

  return (
    <motion.article
      className={`landing-page__feature-card landing-page__feature-card--image-${card.imagePosition}`}
      ref={cardRef}
      style={cardStyle}
    >
      <div className="landing-page__feature-photo" aria-hidden="true">
        <img className="landing-page__feature-photo-image" src={card.image} alt={card.imageAlt} />
      </div>
      <div className="landing-page__feature-copy">
        {index === 0 ? (
          <h2 className="landing-page__feature-title" id="landingFeaturesTitle">
            {card.title}
          </h2>
        ) : (
          <h3 className="landing-page__feature-title">{card.title}</h3>
        )}
        <p className="landing-page__feature-description">{card.description}</p>
      </div>
    </motion.article>
  );
}

function useIncomingCardProgress(targetRef?: React.RefObject<HTMLElement>): MotionValue<number> {
  const isJsdom = typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("jsdom");
  const [activeTargetRef, setActiveTargetRef] = useState<React.RefObject<HTMLElement> | undefined>();

  useEffect(() => {
    setActiveTargetRef(!isJsdom && targetRef?.current ? targetRef : undefined);
  }, [isJsdom, targetRef]);

  const { scrollYProgress } = useScroll({
    target: activeTargetRef,
    offset: stackProgressOffset
  });

  return useTransform(scrollYProgress, (value) => (activeTargetRef ? getStackReactionProgress(value) : 0));
}

function useStackY(nextProgress: MotionValue<number>, secondNextProgress: MotionValue<number>): MotionValue<number> {
  return useTransform([nextProgress, secondNextProgress], ([next, second]) => {
    const stackDepth = Math.min(2, Number(next) + Number(second));
    return -stackCardOffsetY * stackDepth;
  });
}

function useStackScale(nextProgress: MotionValue<number>, secondNextProgress: MotionValue<number>): MotionValue<number> {
  return useTransform([nextProgress, secondNextProgress], ([next, second]) => {
    const stackDepth = Math.min(2, Number(next) + Number(second));
    return 1 - stackCardScaleStep * stackDepth;
  });
}

function AnimatedHeroTitle() {
  return (
    <motion.h1
      id="landingHeroTitle"
      className="landing-page__title"
      variants={heroTitleContainerVariants}
      initial="hidden"
      animate="visible"
    >
      {heroTitleLines.map((line, lineIndex) => (
        <span className="landing-page__title-line" key={line.join(" ")}>
          {line.map((word, wordIndex) => (
            <motion.span className="landing-page__title-word" variants={heroTitleWordVariants} key={word}>
              {word}
              {wordIndex < line.length - 1 ? "\u00a0" : null}
            </motion.span>
          ))}
          {lineIndex < heroTitleLines.length - 1 ? " " : null}
        </span>
      ))}
    </motion.h1>
  );
}

function AnimatedPricingTitle() {
  return (
    <motion.h1
      id="pricingHeroTitle"
      className="pricing-page__title"
      variants={heroTitleContainerVariants}
      initial="hidden"
      animate="visible"
    >
      {pricingTitleLines.map((line, lineIndex) => (
        <span className="landing-page__title-line" key={line.join(" ")}>
          {line.map((word, wordIndex) => (
            <motion.span className="landing-page__title-word" variants={heroTitleWordVariants} key={word}>
              {word}
              {wordIndex < line.length - 1 ? "\u00a0" : null}
            </motion.span>
          ))}
          {lineIndex < pricingTitleLines.length - 1 ? " " : null}
        </span>
      ))}
    </motion.h1>
  );
}

function Brand({
  className = "",
  label = "Aidentity",
  theme = "light"
}: {
  className?: string;
  label?: string;
  theme?: "light" | "dark";
}) {
  const markSrc = aidentityMarkDark;

  return (
    <div className={`aidentity-brand aidentity-brand--${theme} ${className}`} aria-label={label}>
      <img className="aidentity-brand__mark" src={markSrc} alt="" aria-hidden="true" />
      <span className="aidentity-brand__name">{label}</span>
    </div>
  );
}

function AuthScreen({
  onAuthed,
  onReady
}: {
  onAuthed: (user: User) => void;
  onReady: () => Promise<void>;
}) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [step, setStep] = useState<AuthStep>("email");
  const [transition, setTransition] = useState<AuthTransition | null>(null);
  const [email, setEmail] = useState(() => new URLSearchParams(window.location.search).get("email") ?? "");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [isEmailSubmitting, setIsEmailSubmitting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const transitionTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (transitionTimeoutRef.current !== null) {
        window.clearTimeout(transitionTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (step === "email") {
      emailInputRef.current?.focus();
      return;
    }

    passwordInputRef.current?.focus();
  }, [step]);

  function getAuthPanelState(panelStep: AuthStep): PanelState {
    if (transition !== null) {
      if (transition.from === panelStep) {
        return "outgoing";
      }
      if (transition.to === panelStep) {
        return "incoming";
      }
    }

    return step === panelStep ? "active" : "hidden";
  }

  function transitionToStep(nextStep: AuthStep) {
    if (transition !== null || nextStep === step) {
      return;
    }

    setTransition({ from: step, to: nextStep });
    transitionTimeoutRef.current = window.setTimeout(() => {
      setStep(nextStep);
      setTransition(null);
      transitionTimeoutRef.current = null;
    }, panelTransitionDurationMs);
  }

  async function submitEmail(event: FormEvent) {
    event.preventDefault();
    if (isEmailSubmitting || transition !== null) {
      return;
    }

    const normalizedEmail = email.trim();

    if (!normalizedEmail) {
      setEmailError(requiredFieldMessage);
      emailInputRef.current?.focus();
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setEmailError("Please enter a valid email address");
      emailInputRef.current?.focus();
      return;
    }

    setEmail(normalizedEmail);
    setEmailError("");
    setPasswordError("");

    setIsEmailSubmitting(true);
    try {
      const response = await api.checkEmail(normalizedEmail);
      setMode(response.exists ? "login" : "signup");
      transitionToStep("password");
    } catch (lookupError) {
      setEmailError(getErrorMessage(lookupError, "Could not check this email"));
    } finally {
      setIsEmailSubmitting(false);
    }
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (!password) {
      setPasswordError(requiredFieldMessage);
      passwordInputRef.current?.focus();
      return;
    }

    if (password.length < 8) {
      setPasswordError("Password must be at least 8 characters");
      passwordInputRef.current?.focus();
      return;
    }

    setPasswordError("");
    setIsSubmitting(true);

    try {
      const response =
        mode === "login" ? await api.login(email.trim(), password) : await api.signup(email.trim(), password);
      api.clearForcedLogout();
      onAuthed(response.user);
      await onReady();
    } catch (authError) {
      setPasswordError(getErrorMessage(authError, "Authentication failed"));
    } finally {
      setIsSubmitting(false);
    }
  }

  const emailPanelState = getAuthPanelState("email");
  const passwordPanelState = getAuthPanelState("password");

  return (
    <main className="auth-page" aria-label="Authentication">
      <div className="auth-page__inner">
        <Brand />

        <section className="auth-card">
          <div className="auth-card__stage">
            <div
              className={`auth-card__panel auth-card__panel--${emailPanelState}`}
              aria-hidden={emailPanelState !== "active"}
            >
              <header className="auth-card__header">
                <h1>Welcome !</h1>
              </header>

              <form className="auth-card__form" onSubmit={submitEmail} noValidate>
                <FloatingField
                  ref={emailInputRef}
                  autoComplete="email"
                  errorMessage={emailError}
                  inputMode="email"
                  label="Email"
                  name="email"
                  type="email"
                  value={email}
                  onChange={(nextEmail) => {
                    setEmail(nextEmail.trimStart());
                    setEmailError("");
                  }}
                />
                <button
                  className={isEmailSubmitting ? "auth-card__submit auth-card__submit--loading" : "auth-card__submit"}
                  type="submit"
                  disabled={isEmailSubmitting}
                  aria-busy={isEmailSubmitting}
                >
                  {isEmailSubmitting ? <span className="aidentity-button-loader" aria-hidden="true" /> : <span>Continue</span>}
                </button>
              </form>
            </div>

            <div
              className={`auth-card__panel auth-card__panel--${passwordPanelState}`}
              aria-hidden={passwordPanelState !== "active"}
            >
              <header className="auth-card__header">
                <h1>{mode === "login" ? "Enter password" : "Choose password"}</h1>
                <p>
                  {mode === "login" ? (
                    <>
                      Continue as <span>{email}</span>
                    </>
                  ) : (
                    "Use at least 8 characters to secure your Aidentity workspace."
                  )}
                </p>
              </header>

              <form className="auth-card__form" onSubmit={submitPassword} noValidate>
                <FloatingField
                  ref={passwordInputRef}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  errorMessage={passwordError}
                  label="Password"
                  minLength={8}
                  name="password"
                  type="password"
                  value={password}
                  onChange={(nextPassword) => {
                    setPassword(nextPassword);
                    setPasswordError("");
                  }}
                />
                <button
                  className={isSubmitting ? "auth-card__submit auth-card__submit--loading" : "auth-card__submit"}
                  type="submit"
                  disabled={isSubmitting}
                  aria-busy={isSubmitting}
                >
                  {isSubmitting ? <span className="aidentity-button-loader" aria-hidden="true" /> : <span>Continue</span>}
                </button>
              </form>

              <button className="auth-card__back" type="button" onClick={() => transitionToStep("email")}>
                <ArrowLeft size={15} aria-hidden="true" />
                <span>Use another email</span>
              </button>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

interface FloatingFieldProps {
  autoComplete?: string;
  errorMessage?: string;
  inputMode?: React.InputHTMLAttributes<HTMLInputElement>["inputMode"];
  label: string;
  minLength?: number;
  name: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: React.HTMLInputTypeAttribute;
  value: string;
}

const FloatingField = React.forwardRef<HTMLInputElement, FloatingFieldProps>(function FloatingField(
  {
    autoComplete,
    errorMessage,
    inputMode,
    label,
    minLength,
    name,
    onChange,
    placeholder,
    type = "text",
    value
  },
  ref
) {
  const [isFocused, setIsFocused] = useState(false);
  const errorId = useId();
  const hasError = Boolean(errorMessage);
  const isFloating = hasError || isFocused || value.length > 0;
  const state = hasError ? "error" : isFloating ? "focused" : "idle";

  return (
    <div className={`floating-field floating-field--${state}`}>
      <div className="floating-field__shell">
        <label className="floating-field__label" htmlFor={name}>
          <span>{label}</span>
        </label>
        <input
          ref={ref}
          id={name}
          name={name}
          type={type}
          inputMode={inputMode}
          autoComplete={autoComplete}
          aria-invalid={hasError}
          aria-describedby={hasError ? errorId : undefined}
          aria-required="true"
          minLength={minLength}
          placeholder={placeholder}
          value={value}
          onBlur={() => setIsFocused(false)}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setIsFocused(true)}
          required
        />
      </div>
      {hasError ? <FieldError id={errorId} message={errorMessage} /> : null}
    </div>
  );
});

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) {
    return null;
  }

  return (
    <p className="field-error" id={id} role="alert">
      {message}
    </p>
  );
}

function DashboardScreen({
  error,
  user,
  sites,
  selectedSite,
  activeSection,
  activeSiteDetailTab,
  activeUserSettingsSection,
  selectedApiKeys,
  onCreateSite,
  onLogout,
  onSelectSite,
  onOpenDashboard,
  onOpenDashboardChat,
  onOpenProfileSettings,
  onUserSettingsSectionChange,
  onUserUpdated,
  onSiteDetailTabChange,
  onApiKeyCreated,
  onApiKeyDeleted,
  onSiteDetailLoaded,
  onSiteUpdated,
  onSiteDeleted,
  onNotify,
  onCloseDetail
}: {
  error: string;
  user: User;
  sites: Site[];
  selectedSite: Site | null;
  activeSection: DashboardSection;
  activeSiteDetailTab: SiteDetailTab;
  activeUserSettingsSection: UserSettingsSection;
  selectedApiKeys: SiteApiKey[];
  onCreateSite: () => void;
  onLogout: () => void;
  onSelectSite: (siteId: string) => void;
  onOpenDashboard: () => void;
  onOpenDashboardChat: () => void;
  onOpenProfileSettings: () => void;
  onUserSettingsSectionChange: (section: UserSettingsSection) => void;
  onUserUpdated: (user: User) => void;
  onSiteDetailTabChange: (siteId: string, tab: SiteDetailTab) => void;
  onApiKeyCreated: (apiKey: SiteApiKey) => void;
  onApiKeyDeleted: (apiKeyId: string) => void;
  onSiteDetailLoaded: (detail: SiteDetailResponse) => void;
  onSiteUpdated: (site: Site) => void;
  onSiteDeleted: (siteId: string) => void;
  onNotify: (notification: ToastNotificationInput) => void;
  onCloseDetail: () => void;
}) {
  return (
    <main className="dashboard-page">
      <aside className="dashboard-page__rail">
        <div className="dashboard-page__rail-top">
          <Brand className="dashboard-page__brand" />
          <nav className="dashboard-page__rail-nav" aria-label="Dashboard">
            <button
              className={`dashboard-page__rail-button${activeSection === "sites" ? " dashboard-page__rail-button--active" : ""}`}
              type="button"
              onClick={onOpenDashboard}
            >
              <DashboardSitesIcon />
              <span>Identities</span>
            </button>
            <button
              className={`dashboard-page__rail-button${activeSection === "chat" ? " dashboard-page__rail-button--active" : ""}`}
              type="button"
              onClick={onOpenDashboardChat}
            >
              <DashboardChatIcon />
              <span>Chat</span>
            </button>
            <button className="dashboard-page__rail-button" type="button" onClick={onCreateSite}>
              <Plus size={18} aria-hidden="true" />
              <span>New identity</span>
            </button>
          </nav>
        </div>

        <div className="dashboard-page__rail-footer">
          <button
            className={`dashboard-page__identity${activeSection === "settings" ? " dashboard-page__identity--active" : ""}`}
            type="button"
            title={user.email}
            onClick={onOpenProfileSettings}
          >
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt="" />
            ) : (
              <span>{getUserInitials(user.displayName ?? getDashboardChatGreetingName(user.email), user.email)}</span>
            )}
          </button>
          <button className="dashboard-page__logout" type="button" onClick={onLogout}>
            <LogOut size={18} aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {activeSection === "chat" ? (
        <DashboardChatScreen user={user} sites={sites} />
      ) : activeSection === "settings" ? (
        <UserSettingsPage
          user={user}
          activeSection={activeUserSettingsSection}
          sites={sites}
          onSectionChange={onUserSettingsSectionChange}
          onUserUpdated={onUserUpdated}
          onNotify={onNotify}
          onBack={onOpenDashboard}
          onLogout={onLogout}
        />
      ) : selectedSite ? (
        <SiteDetailOverlay
          site={selectedSite}
          activeTab={activeSiteDetailTab}
          apiKeys={selectedApiKeys}
          onApiKeyCreated={onApiKeyCreated}
          onApiKeyDeleted={onApiKeyDeleted}
          onSiteDetailLoaded={onSiteDetailLoaded}
          onSiteUpdated={onSiteUpdated}
          onSiteDeleted={onSiteDeleted}
          onNotify={onNotify}
          onTabChange={(tab) => onSiteDetailTabChange(selectedSite.id, tab)}
          onClose={onCloseDetail}
        />
      ) : (
        <section className="dashboard-page__workspace dashboard-page__workspace--projects">
          <div className="dashboard-page__projects-view" aria-labelledby="sitesTitle">
            <div className="dashboard-page__projects-shell">
              <header className="dashboard-page__projects-header">
                <h1 id="sitesTitle" className="dashboard-page__projects-title">
                  Agent identities
                </h1>
              </header>

              <div className="dashboard-page__projects-grid-shell">
                {error ? (
                  <ProjectsState message={error} />
                ) : sites.length === 0 ? (
                  <button className="dashboard-page__empty-state" type="button" onClick={onCreateSite}>
                    <Plus size={20} aria-hidden="true" />
                    <span>Create your first agent identity</span>
                    <small>Provision phone, email, card, calendar, and an OpenClaw link.</small>
                  </button>
                ) : (
                  <div className="dashboard-page__projects-grid">
                    <button
                      className="dashboard-page__project-card dashboard-page__project-card--create"
                      type="button"
                      style={getProjectCardStyle(0)}
                      onClick={onCreateSite}
                    >
                      <div className="dashboard-page__project-preview dashboard-page__project-preview--create">
                        <Plus size={24} aria-hidden="true" />
                      </div>
                      <div className="dashboard-page__project-meta">
                        <div className="dashboard-page__project-copy">
                          <h2>New identity</h2>
                          <p>Give an agent real-world tools</p>
                        </div>
                      </div>
                    </button>

                    {sites.map((site, index) => (
                      <button
                        key={site.id}
                        className="dashboard-page__project-card"
                        type="button"
                        style={getProjectCardStyle(index + 1)}
                        onClick={() => onSelectSite(site.id)}
                      >
                        <div className="dashboard-page__project-preview">
                          <img src={getSitePreviewImage(site)} alt="" aria-hidden="true" />
                        </div>
                        <div className="dashboard-page__project-meta">
                          <div className="dashboard-page__project-copy">
                            <h2 title={site.name}>{site.name}</h2>
                            <p>{formatSiteRelativeTime(site.updatedAt)}</p>
                          </div>
                          <span className="dashboard-page__project-pill">OpenClaw linked</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

function ProjectsState({ message }: { message: string }) {
  return <div className="dashboard-page__projects-state">{message}</div>;
}

function DashboardChatScreen({ user, sites }: { user: User; sites: Site[] }) {
  const [messages, setMessages] = useState<DashboardChatMessage[]>([]);
  const [expandedActivityMessageIds, setExpandedActivityMessageIds] = useState<Set<string>>(() => new Set());
  const [composerValue, setComposerValue] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const [isWaitingForFirstToken, setIsWaitingForFirstToken] = useState(false);
  const [chatError, setChatError] = useState("");
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const greetingName = user.displayName?.trim() || getDashboardChatGreetingName(user.email);
  const canSubmitComposer = composerValue.trim().length > 0 && !isResponding;

  useEffect(() => {
    const threadElement = threadRef.current;
    if (!threadElement) {
      return;
    }

    const scrollBehavior: ScrollBehavior = messages.length > 1 && !isResponding ? "smooth" : "auto";
    const animationFrameId = window.requestAnimationFrame(() => {
      threadElement.scrollTo({
        top: threadElement.scrollHeight,
        behavior: scrollBehavior
      });
    });

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [messages, isResponding, isWaitingForFirstToken]);

  useEffect(() => {
    resizeDashboardChatComposer(composerInputRef.current);
  }, [composerValue]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const prompt = composerValue.trim();
    if (!prompt || isResponding) {
      return;
    }

    const userMessage = createDashboardChatMessage("user", prompt);
    const assistantMessage = createDashboardChatMessage("assistant", "");
    const messagesForRequest = [...messages, userMessage];
    const nextMessages = [...messagesForRequest, assistantMessage];
    setMessages(nextMessages);
    setComposerValue("");
    setChatError("");
    setIsResponding(true);
    setIsWaitingForFirstToken(true);

    try {
      await api.sendDashboardChatMessage(toDashboardChatApiMessages(messagesForRequest), (streamEvent) => {
        if (streamEvent.type === "call_started") {
          setIsWaitingForFirstToken(false);
          setMessages((currentMessages) =>
            currentMessages.map((message) =>
              message.id === assistantMessage.id
                ? { ...message, callEmbed: { ...streamEvent.call, state: "in_progress" } }
                : message
            )
          );
          return;
        }

        if (streamEvent.type === "call_completed") {
          setIsWaitingForFirstToken(false);
          setMessages((currentMessages) =>
            currentMessages.map((message) =>
              message.id === assistantMessage.id
                ? { ...message, callEmbed: { ...streamEvent.call, state: "completed" } }
                : message
            )
          );
          return;
        }

        if (streamEvent.type !== "delta" || !streamEvent.text) {
          return;
        }

        setIsWaitingForFirstToken(false);
        setMessages((currentMessages) =>
          currentMessages.map((message) =>
            message.id === assistantMessage.id ? { ...message, content: message.content + streamEvent.text } : message
          )
        );
      });
    } catch (error) {
      setMessages((currentMessages) =>
        currentMessages.filter((message) => message.id !== assistantMessage.id || message.content.trim().length > 0)
      );
      setChatError(getErrorMessage(error, "Aidentity could not answer right now."));
    } finally {
      setIsWaitingForFirstToken(false);
      setIsResponding(false);
    }
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    if (canSubmitComposer) {
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <section className="dashboard-page__workspace dashboard-chat" aria-labelledby="dashboardChatTitle">
      <h1 id="dashboardChatTitle" className="dashboard-chat__sr-only">
        Chat
      </h1>
      <div className="dashboard-chat__layout">
        <div className="dashboard-chat__content-column">
          <div ref={threadRef} className="dashboard-chat__thread" aria-live="polite">
            <div className="dashboard-chat__conversation-list">
              {messages.length === 0 ? (
                <div className="dashboard-chat__empty-state">
                  <h2 className="dashboard-chat__empty-state-greeting">
                    Good {getTimeOfDayLabel()}
                    <span className="dashboard-chat__empty-state-dash"> - </span>
                    <span className="dashboard-chat__empty-state-name">{greetingName}</span>
                  </h2>
                </div>
              ) : (
                messages
                  .filter((message) => message.role === "user" || message.content.length > 0 || message.callEmbed)
                  .map((message) => (
                    <div
                      key={message.id}
                      className={`dashboard-chat__conversation-item dashboard-chat__conversation-item--${message.role}`}
                    >
                      <article className={`dashboard-chat__message dashboard-chat__message--${message.role}`}>
                        {message.clarificationDetails ? (
                          <DashboardChatActivityMessage
                            message={message}
                            expanded={expandedActivityMessageIds.has(message.id)}
                            onToggle={() => {
                              setExpandedActivityMessageIds((currentIds) => {
                                const nextIds = new Set(currentIds);
                                if (nextIds.has(message.id)) {
                                  nextIds.delete(message.id);
                                } else {
                                  nextIds.add(message.id);
                                }
                                return nextIds;
                              });
                            }}
                          />
                        ) : (
                          <div className="dashboard-chat__message-content">
                            {message.callEmbed ? <DashboardChatCallEmbedCard call={message.callEmbed} /> : null}
                            <DashboardChatMessageText message={message} />
                          </div>
                        )}
                      </article>
                    </div>
                  ))
              )}

              {isResponding && isWaitingForFirstToken ? (
                <div className="dashboard-chat__conversation-item dashboard-chat__conversation-item--assistant dashboard-chat__conversation-item--thinking">
                  <article className="dashboard-chat__message dashboard-chat__message--assistant dashboard-chat__message--thinking">
                    <p className="dashboard-chat__message-content dashboard-chat__message-content--thinking">
                      Thinking...
                    </p>
                  </article>
                </div>
              ) : null}

              {chatError ? <div className="dashboard-chat__error" role="alert">{chatError}</div> : null}
            </div>
          </div>

          <div className="dashboard-chat__composer-shell">
            <form className="dashboard-chat__composer" onSubmit={handleSubmit}>
              <label className="dashboard-chat__sr-only" htmlFor="dashboardChatPrompt">
                Message Aidentity
              </label>
              <div className="dashboard-chat__composer-body">
                <textarea
                  ref={composerInputRef}
                  id="dashboardChatPrompt"
                  className="dashboard-chat__composer-input"
                  name="message"
                  placeholder="Ask your agent (openclaw) anything"
                  rows={1}
                  value={composerValue}
                  onChange={(event) => {
                    setComposerValue(event.target.value);
                    resizeDashboardChatComposer(event.currentTarget);
                  }}
                  onKeyDown={handleComposerKeyDown}
                />
              </div>

              <div className="dashboard-chat__composer-footer">
                <button className="dashboard-chat__composer-attach" type="button" aria-label="Attach context">
                  <DashboardChatPlusIcon />
                </button>

                <div className="dashboard-chat__composer-actions">
                  <DashboardChatMicIcon />
                  <button
                    className="dashboard-chat__composer-submit"
                    type="submit"
                    aria-label="Send message"
                    disabled={!canSubmitComposer}
                  >
                    <DashboardChatSendIcon />
                  </button>
                </div>
              </div>
            </form>

            <div className="dashboard-chat__composer-meta" aria-hidden="true">
              <div className="dashboard-chat__composer-meta-group">
                <DashboardChatFolderIcon />
                <span className="dashboard-chat__composer-meta-text">Aidentity dashboard</span>
                <DashboardChatChevronIcon />
              </div>
              <div className="dashboard-chat__composer-meta-group dashboard-chat__composer-meta-group--sites">
                <DashboardChatLoaderIcon />
                <span className="dashboard-chat__composer-meta-text">
                  {sites.length === 1 ? "1 identity" : `${sites.length} identities`}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function DashboardChatActivityMessage({
  message,
  expanded,
  onToggle
}: {
  message: DashboardChatMessage;
  expanded: boolean;
  onToggle: () => void;
}) {
  const details = message.clarificationDetails;
  const detailRegionId = `${message.id}-activity-details`;

  if (!details) {
    return null;
  }

  return (
    <>
      <button
        className="dashboard-chat__activity-toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={detailRegionId}
        onClick={onToggle}
      >
        {message.content}
      </button>
      {expanded ? (
        <div id={detailRegionId} className="dashboard-chat__activity-details">
          {details.entries.map((entry, index) => (
            <div className="dashboard-chat__activity-entry" key={`${entry.question}-${index}`}>
              <p className="dashboard-chat__activity-line">
                <span className="dashboard-chat__activity-line-label">Question:</span> {entry.question}
              </p>
              <p className="dashboard-chat__activity-line">
                <span className="dashboard-chat__activity-line-label">Answer:</span> {entry.answer}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function DashboardChatCallEmbedCard({ call }: { call: DashboardChatMessage["callEmbed"] }) {
  if (!call) {
    return null;
  }

  const transcript = call.transcript ?? [];
  const hasTranscript = transcript.length > 0;
  const isCompleted = call.state === "completed";

  return (
    <section className={`dashboard-chat__call-card dashboard-chat__call-card--${call.state}`} aria-label="Phone call">
      <div className="dashboard-chat__call-card-header">
        <div className="dashboard-chat__call-card-title">
          <span className="dashboard-chat__call-card-icon" aria-hidden="true">
            <Phone size={16} />
          </span>
          <div>
            <p>{isCompleted ? "Call completed" : "Call in progress"}</p>
            <span>{call.recipientName || call.toNumber}</span>
          </div>
        </div>
        <div className="dashboard-chat__call-card-status" aria-label={isCompleted ? "Completed" : "In progress"}>
          <span />
          {isCompleted ? formatCallDuration(call.durationSecs) : "Live"}
        </div>
      </div>

      <div className="dashboard-chat__call-card-body">
        <p className="dashboard-chat__call-card-task">{call.task}</p>
        <div className="dashboard-chat__call-card-meta">
          <span>{call.toNumber}</span>
          <span>{call.simulated ? "Mock voice provider" : "Voice provider"}</span>
        </div>
      </div>

      {isCompleted ? (
        <div className="dashboard-chat__call-transcript" aria-label="Call transcript">
          <div className="dashboard-chat__call-transcript-heading">
            <span>Transcript</span>
            <span>{call.status}</span>
          </div>
          {hasTranscript ? (
            transcript.map((turn, turnIndex) => (
              <div className="dashboard-chat__call-transcript-turn" key={`${turn.role}-${turnIndex}`}>
                <span className="dashboard-chat__call-transcript-speaker">{formatTranscriptRole(turn.role)}</span>
                <p>
                  {splitTranscriptWords(turn.message).map((word, wordIndex) => (
                    <span
                      className="dashboard-chat__call-transcript-word"
                      key={`${word}-${wordIndex}`}
                      style={{ "--word-index": wordIndex + turnIndex * 8 } as CSSProperties}
                    >
                      {word}
                    </span>
                  ))}
                </p>
              </div>
            ))
          ) : (
            <p className="dashboard-chat__call-transcript-empty">The call ended before transcript text was returned.</p>
          )}
        </div>
      ) : (
        <div className="dashboard-chat__call-progress" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
      )}
    </section>
  );
}

function DashboardChatMessageText({ message }: { message: DashboardChatMessage }) {
  if (message.role !== "assistant") {
    return <>{message.content}</>;
  }

  return (
    <div className="dashboard-chat__markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={dashboardChatMarkdownComponents}
      >
        {normalizeDashboardChatMarkdown(message.content)}
      </ReactMarkdown>
    </div>
  );
}

const dashboardChatMarkdownComponents: Components = {
  table: DashboardChatMarkdownTable,
  pre: DashboardChatMarkdownPre
};

function DashboardChatMarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <div className="dashboard-chat__markdown-table-scroll">
      <table>{children}</table>
    </div>
  );
}

function DashboardChatMarkdownPre({ children }: { children?: ReactNode }) {
  const text = getReactNodeText(children).trim();

  if (isMarkdownTableBlock(text)) {
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={dashboardChatMarkdownComponents}>
        {normalizeDashboardChatMarkdown(text)}
      </ReactMarkdown>
    );
  }

  return <pre>{children}</pre>;
}

function normalizeDashboardChatMarkdown(value: string): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const normalizedLines: string[] = [];
  let isInsideFence = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith("```") || trimmedLine.startsWith("~~~")) {
      isInsideFence = !isInsideFence;
      normalizedLines.push(line);
      continue;
    }

    const nextLine = lines[index + 1] ?? "";
    if (
      !isInsideFence &&
      isMarkdownTableHeaderLine(line) &&
      isMarkdownTableSeparatorLikeLine(nextLine)
    ) {
      const cellCount = getMarkdownPipeCellCount(line);
      normalizedLines.push(line);
      normalizedLines.push(buildMarkdownTableSeparatorLine(cellCount));
      index++;
      continue;
    }

    normalizedLines.push(line);
  }

  return normalizedLines.join("\n");
}

function formatCallDuration(durationSecs: number | null | undefined): string {
  if (typeof durationSecs !== "number" || !Number.isFinite(durationSecs) || durationSecs <= 0) {
    return "Done";
  }

  const minutes = Math.floor(durationSecs / 60);
  const seconds = Math.floor(durationSecs % 60);
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function formatTranscriptRole(role: string): string {
  const normalizedRole = role.trim().toLowerCase();
  if (normalizedRole === "agent" || normalizedRole === "assistant") {
    return "Agent";
  }
  if (normalizedRole === "user") {
    return "Recipient";
  }

  return role.trim() || "Speaker";
}

function splitTranscriptWords(value: string): string[] {
  return value.split(/(\s+)/).filter(Boolean);
}

function isMarkdownTableHeaderLine(value: string): boolean {
  return getMarkdownPipeCellCount(value) >= 2;
}

function isMarkdownTableSeparatorLikeLine(value: string): boolean {
  const trimmedValue = value.trim();
  return trimmedValue.includes("|") && /-/.test(trimmedValue) && /^[\s|:-]+$/.test(trimmedValue);
}

function getMarkdownPipeCellCount(value: string): number {
  const trimmedValue = value.trim();
  if (!trimmedValue.includes("|")) {
    return 0;
  }

  return trimmedValue
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .length;
}

function buildMarkdownTableSeparatorLine(cellCount: number): string {
  return `| ${Array.from({ length: cellCount }, () => "---").join(" | ")} |`;
}

function getReactNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(getReactNodeText).join("");
  }

  if (React.isValidElement<{ children?: ReactNode }>(node)) {
    return getReactNodeText(node.props.children);
  }

  return "";
}

function isMarkdownTableBlock(value: string): boolean {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2 || !lines[0].includes("|") || !lines[1].includes("|")) {
    return false;
  }

  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[1]);
}

function getDashboardChatGreetingName(email: string): string {
  const localPart = email.split("@")[0]?.trim();
  if (!localPart) {
    return "there";
  }

  const firstSegment = localPart.split(/[._-]/).find(Boolean) ?? localPart;
  return firstSegment.charAt(0).toUpperCase() + firstSegment.slice(1);
}

function getTimeOfDayLabel(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) {
    return "Morning";
  }

  if (hour < 18) {
    return "Afternoon";
  }

  return "Evening";
}

function createDashboardChatMessage(role: DashboardChatRole, content: string): DashboardChatMessage {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return {
    id: `dashboard-chat-${role}-${suffix}`,
    role,
    content
  };
}

function toDashboardChatApiMessages(messages: DashboardChatMessage[]): DashboardChatMessageInput[] {
  return messages.slice(-50).map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function resizeDashboardChatComposer(inputElement: HTMLTextAreaElement | null) {
  if (!inputElement) {
    return;
  }

  inputElement.style.height = "0px";
  inputElement.style.height = `${Math.min(180, Math.max(20, inputElement.scrollHeight))}px`;
}

function DashboardSitesIcon() {
  return (
    <svg className="dashboard-page__rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M3 6a3 3 0 0 1 3-3h2.25a3 3 0 0 1 3 3v2.25a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6Zm9.75 0a3 3 0 0 1 3-3H18a3 3 0 0 1 3 3v2.25a3 3 0 0 1-3 3h-2.25a3 3 0 0 1-3-3V6ZM3 15.75a3 3 0 0 1 3-3h2.25a3 3 0 0 1 3 3V18a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-2.25Zm9.75 0a3 3 0 0 1 3-3H18a3 3 0 0 1 3 3V18a3 3 0 0 1-3 3h-2.25a3 3 0 0 1-3-3v-2.25Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function DashboardChatIcon() {
  return (
    <svg className="dashboard-page__rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M5.337 21.718a6.707 6.707 0 0 1-.533-.074.75.75 0 0 1-.44-1.223 3.73 3.73 0 0 0 .814-1.686c.023-.115-.022-.317-.254-.543C3.274 16.587 2.25 14.41 2.25 12c0-5.03 4.428-9 9.75-9s9.75 3.97 9.75 9c0 5.03-4.428 9-9.75 9-.833 0-1.643-.097-2.417-.279a6.721 6.721 0 0 1-4.246.997Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function DashboardChatPlusIcon() {
  return (
    <svg className="dashboard-chat__composer-icon dashboard-chat__composer-icon--plus" viewBox="0 0 21 21" aria-hidden="true">
      <path d="M16.625 9.625h-5.25v-5.25a.875.875 0 0 0-1.75 0v5.25h-5.25a.875.875 0 0 0 0 1.75h5.25v5.25a.875.875 0 0 0 1.75 0v-5.25h5.25a.875.875 0 0 0 0-1.75Z" />
    </svg>
  );
}

function DashboardChatMicIcon() {
  return (
    <svg className="dashboard-chat__composer-icon dashboard-chat__composer-icon--mic" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M9 11.25a3 3 0 0 0 3-3V4.5a3 3 0 0 0-6 0v3.75a3 3 0 0 0 3 3Zm-1.5-6.75a1.5 1.5 0 0 1 3 0v3.75a1.5 1.5 0 0 1-3 0V4.5Z" />
      <path d="M14.25 8.25a.75.75 0 0 0-1.5 0 3.75 3.75 0 0 1-7.5 0 .75.75 0 0 0-1.5 0 5.25 5.25 0 0 0 4.5 5.19V15H6.667A.667.667 0 0 0 6 15.667v.165c0 .369.299.668.667.668h4.666a.667.667 0 0 0 .667-.668v-.165a.667.667 0 0 0-.667-.667H9.75v-1.56a5.25 5.25 0 0 0 4.5-5.19Z" />
    </svg>
  );
}

function DashboardChatSendIcon() {
  return (
    <svg className="dashboard-chat__composer-send-icon" viewBox="0 0 19 19" aria-hidden="true">
      <path d="M9.5 16.5V3" />
      <path d="M3.961 8.542 9.503 3l5.542 5.542" />
    </svg>
  );
}

function DashboardChatFolderIcon() {
  return (
    <svg className="dashboard-chat__composer-meta-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13 13.667H3a1.6 1.6 0 0 1-1.667-1.62V3.954A1.6 1.6 0 0 1 3 2.334h3.066c.2.001.389.092.513.247l1.733 2.12h4.667a1.6 1.6 0 0 1 1.686 1.62v5.726a1.6 1.6 0 0 1-1.666 1.62ZM2.666 9.174v2.873c.003.17.163.307.333.287h10c.17.02.33-.118.333-.287V6.32c-.003-.169-.163-.306-.333-.286H8a.667.667 0 0 1-.514-.247l-1.733-2.12H3c-.17-.02-.33.117-.333.286v5.22Z" />
    </svg>
  );
}

function DashboardChatLoaderIcon() {
  return (
    <svg className="dashboard-chat__composer-meta-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.334a.667.667 0 0 0-.667.667v1.333a.667.667 0 1 0 1.334 0V2a.667.667 0 0 0-.667-.667Zm6 6h-1.333a.667.667 0 0 0 0 1.333H14a.667.667 0 0 0 0-1.333Zm-10 0a.667.667 0 0 0-.667-.667H2a.667.667 0 0 0 0 1.333h1.333A.667.667 0 0 0 4 7.334ZM4.146 3.333a.667.667 0 1 0-.927.96l.96.947a.667.667 0 1 0 .966-.92l-1-.987Zm7.707 0-.96.947a.667.667 0 0 0 .9.96l.96-.927a.667.667 0 1 0-.9-.98ZM8 12a.667.667 0 0 0-.667.667V14a.667.667 0 1 0 1.334 0v-1.333A.667.667 0 0 0 8 12Zm3.822-1.24a.667.667 0 1 0-.927.96l.96.946a.667.667 0 1 0 .94-.946l-.973-.96Zm-7.641 0-.96.927a.667.667 0 0 0 .927.96l.96-.927a.667.667 0 1 0-.927-.96Z" />
    </svg>
  );
}

function DashboardChatChevronIcon() {
  return (
    <svg className="dashboard-chat__composer-meta-chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 5.5 8 10l4.5-4.5" />
    </svg>
  );
}

function UserSettingsPage({
  user,
  activeSection,
  sites,
  onSectionChange,
  onUserUpdated,
  onNotify,
  onBack,
  onLogout
}: {
  user: User;
  activeSection: UserSettingsSection;
  sites: Site[];
  onSectionChange: (section: UserSettingsSection) => void;
  onUserUpdated: (user: User) => void;
  onNotify: (notification: ToastNotificationInput) => void;
  onBack: () => void;
  onLogout: () => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName ?? getDashboardChatGreetingName(user.email));
  const [email, setEmail] = useState(user.email);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? "");
  const [avatarInputKey, setAvatarInputKey] = useState(0);
  const [productEmails, setProductEmails] = useState(user.notificationPreferences.productEmails);
  const [identityEmails, setIdentityEmails] = useState(user.notificationPreferences.identityEmails);
  const [securityEmails, setSecurityEmails] = useState(user.notificationPreferences.securityEmails);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [isSavingNotifications, setIsSavingNotifications] = useState(false);
  const [notificationsError, setNotificationsError] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const avatarInputId = useId();
  const joinedDate = formatProfileDate(user.createdAt);
  const initials = getUserInitials(displayName, email);
  const normalizedDisplayName = displayName.trim();
  const normalizedEmail = email.trim();
  const normalizedAvatarUrl = avatarUrl.trim() || null;
  const currentAvatarUrl = user.avatarUrl ?? null;
  const hasProfileChanges =
    normalizedDisplayName !== (user.displayName ?? getDashboardChatGreetingName(user.email)) ||
    normalizedEmail !== user.email ||
    normalizedAvatarUrl !== currentAvatarUrl;
  const hasNotificationChanges =
    productEmails !== user.notificationPreferences.productEmails ||
    identityEmails !== user.notificationPreferences.identityEmails ||
    securityEmails !== user.notificationPreferences.securityEmails;

  useEffect(() => {
    setDisplayName(user.displayName ?? getDashboardChatGreetingName(user.email));
    setEmail(user.email);
    setAvatarUrl(user.avatarUrl ?? "");
    setProductEmails(user.notificationPreferences.productEmails);
    setIdentityEmails(user.notificationPreferences.identityEmails);
    setSecurityEmails(user.notificationPreferences.securityEmails);
  }, [user]);

  async function saveProfileSettings() {
    if (!normalizedDisplayName || !normalizedEmail) {
      setProfileError("Display name and email are required.");
      return;
    }

    setIsSavingProfile(true);
    setProfileError("");

    try {
      const response = await api.updateProfile({
        displayName: normalizedDisplayName,
        email: normalizedEmail,
        avatarUrl: normalizedAvatarUrl
      });
      onUserUpdated(response.user);
      onNotify({
        title: "Profile saved"
      });
    } catch (error) {
      setProfileError(getErrorMessage(error, "Could not save profile"));
    } finally {
      setIsSavingProfile(false);
    }
  }

  function updateAvatarFromFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (!profileAvatarAcceptedTypes.has(file.type)) {
      setProfileError("Choose a PNG, JPEG, WebP, or GIF image.");
      setAvatarInputKey((key) => key + 1);
      return;
    }

    if (file.size > profileAvatarMaxBytes) {
      setProfileError("Profile picture must be under 256 KB.");
      setAvatarInputKey((key) => key + 1);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setProfileError("Could not read that image.");
        return;
      }

      setAvatarUrl(reader.result);
      setProfileError("");
    };
    reader.onerror = () => setProfileError("Could not read that image.");
    reader.readAsDataURL(file);
  }

  function removeAvatar() {
    setAvatarUrl("");
    setAvatarInputKey((key) => key + 1);
    setProfileError("");
  }

  async function saveNotificationSettings() {
    setIsSavingNotifications(true);
    setNotificationsError("");

    try {
      const response = await api.updateNotificationPreferences({
        productEmails,
        identityEmails,
        securityEmails
      });
      onUserUpdated(response.user);
      onNotify({
        title: "Notification preferences saved"
      });
    } catch (error) {
      setNotificationsError(getErrorMessage(error, "Could not save notification preferences"));
    } finally {
      setIsSavingNotifications(false);
    }
  }

  async function savePasswordSettings() {
    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError("All password fields are required.");
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match.");
      return;
    }

    setIsSavingPassword(true);
    setPasswordError("");

    try {
      await api.updatePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setIsPasswordModalOpen(false);
      onNotify({
        title: "Password updated"
      });
    } catch (error) {
      setPasswordError(getErrorMessage(error, "Could not update password"));
    } finally {
      setIsSavingPassword(false);
    }
  }

  function openPasswordModal() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError("");
    setIsPasswordModalOpen(true);
  }

  function closePasswordModal() {
    if (isSavingPassword) {
      return;
    }

    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError("");
    setIsPasswordModalOpen(false);
  }

  return (
    <>
      <section className="site-detail-page user-settings-page dashboard-page__workspace" aria-labelledby="userSettingsTitle">
        <div className="site-detail-page__shell">
          <aside className="site-detail-page__sidebar" aria-label="Profile settings sections">
            <button className="site-detail-page__back" type="button" onClick={onBack} aria-label="Back to identities">
              <BackChevronIcon />
            </button>

            <nav className="site-detail-page__tabs" role="tablist" aria-label="Profile settings">
            <UserSettingsTab
              section="profile"
              activeSection={activeSection}
              label="Profile"
              icon="profile"
              onSectionChange={onSectionChange}
            />
            <UserSettingsTab
              section="security"
              activeSection={activeSection}
              label="Security"
              icon="security"
              onSectionChange={onSectionChange}
            />
            <UserSettingsTab
              section="notifications"
              activeSection={activeSection}
              label="Notifications"
              icon="notifications"
              onSectionChange={onSectionChange}
            />
            <UserSettingsTab
              section="billing"
              activeSection={activeSection}
              label="Billing"
              icon="billing"
              onSectionChange={onSectionChange}
            />
            </nav>
          </aside>

          <div
            className="site-detail-page__content"
            key={activeSection}
            id={`user-settings-${activeSection}-panel`}
            role="tabpanel"
            aria-labelledby={`user-settings-${activeSection}-tab`}
          >
          {activeSection === "profile" ? (
            <>
              <header className="site-detail-page__header">
                <div>
                  <h1 id="userSettingsTitle">Profile</h1>
                </div>
                <button
                  className={`site-detail-page__save${isSavingProfile ? " site-detail-page__save--saving" : ""}`}
                  type="button"
                  onClick={() => void saveProfileSettings()}
                  disabled={isSavingProfile || !normalizedDisplayName || !normalizedEmail || !hasProfileChanges}
                >
                  {isSavingProfile ? <Loader2 size={15} strokeWidth={3.2} aria-hidden="true" /> : <span>Save</span>}
                </button>
              </header>

              <div className="site-detail-page__form-grid user-settings-page__profile-grid">
                <div className="site-detail-page__preview user-settings-page__profile-preview" aria-label="Profile preview">
                  <span>Preview</span>
                  <div className="site-detail-page__preview-card user-settings-page__profile-card">
                    <div className="user-settings-page__avatar user-settings-page__avatar--large" aria-hidden="true">
                      {avatarUrl ? <img src={avatarUrl} alt="" /> : initials}
                    </div>
                    <strong>{displayName || email}</strong>
                    <p>{email}</p>
                    <div className="user-settings-page__avatar-actions">
                      <label className="user-settings-page__avatar-upload" htmlFor={avatarInputId}>
                        <input
                          key={avatarInputKey}
                          id={avatarInputId}
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          onChange={updateAvatarFromFile}
                        />
                        <span>{avatarUrl ? "Change photo" : "Upload photo"}</span>
                      </label>
                      {avatarUrl ? (
                        <button className="user-settings-page__avatar-remove" type="button" onClick={removeAvatar}>
                          Remove
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>

                <label className="site-detail-page__field">
                  <span>Display name</span>
                  <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
                </label>

                <label className="site-detail-page__field">
                  <span>Email</span>
                  <input value={email} onChange={(event) => setEmail(event.target.value)} />
                </label>
              </div>

              {profileError ? <p className="site-detail-panel__error">{profileError}</p> : null}

              <section className="site-detail-panel__api-key site-detail-page__section">
                <div className="site-detail-page__section-heading">
                  <div>
                    <h3>Account details</h3>
                    <p>Basic information used across the Aidentity dashboard.</p>
                  </div>
                </div>
                <div className="user-settings-page__info-grid">
                  <UserSettingsInfo label="User ID" value={user.id} />
                  <UserSettingsInfo label="Created" value={joinedDate} />
                  <UserSettingsInfo label="Agent identities" value={`${sites.length}`} />
                </div>
              </section>
            </>
          ) : activeSection === "security" ? (
            <>
              <header className="site-detail-page__header">
                <div>
                  <h1 id="userSettingsTitle">Security</h1>
                </div>
              </header>

              <section className="site-detail-panel__api-key site-detail-page__section site-detail-page__section--flush">
                <div className="site-detail-page__section-heading">
                  <div>
                    <h3>Password</h3>
                    <p>Update the password used to sign in to this dashboard.</p>
                  </div>
                  <button
                    className="site-detail-page__section-action"
                    type="button"
                    onClick={openPasswordModal}
                  >
                    Change password
                  </button>
                </div>
              </section>

              <section className="site-detail-panel__api-key site-detail-page__section">
                <div className="site-detail-page__section-heading">
                  <div>
                    <h3>Active session</h3>
                    <p>This browser is signed in with an HTTP-only session cookie.</p>
                  </div>
                  <button className="site-detail-page__section-action" type="button" onClick={onLogout}>
                    Sign out
                  </button>
                </div>
              </section>
            </>
          ) : activeSection === "notifications" ? (
            <>
              <header className="site-detail-page__header">
                <div>
                  <h1 id="userSettingsTitle">Notifications</h1>
                </div>
                <button
                  className={`site-detail-page__save${isSavingNotifications ? " site-detail-page__save--saving" : ""}`}
                  type="button"
                  onClick={() => void saveNotificationSettings()}
                  disabled={isSavingNotifications || !hasNotificationChanges}
                >
                  {isSavingNotifications ? <Loader2 size={15} strokeWidth={3.2} aria-hidden="true" /> : <span>Save</span>}
                </button>
              </header>

              <section className="site-detail-panel__api-key site-detail-page__section site-detail-page__section--flush">
                <div className="site-detail-page__section-heading">
                  <div>
                    <h3>Email preferences</h3>
                    <p>Choose which dashboard updates should reach your inbox.</p>
                  </div>
                </div>
                <div className="user-settings-page__toggle-list">
                  <UserSettingsToggle
                    label="Product updates"
                    description="New dashboard capabilities, identity improvements, and release notes."
                    checked={productEmails}
                    onChange={setProductEmails}
                  />
                  <UserSettingsToggle
                    label="Identity status"
                    description="OpenClaw links, identity setup, and tool provisioning updates."
                    checked={identityEmails}
                    onChange={setIdentityEmails}
                  />
                  <UserSettingsToggle
                    label="Security alerts"
                    description="Sign-in, session, and credential-related notices."
                    checked={securityEmails}
                    onChange={setSecurityEmails}
                  />
                </div>
                {notificationsError ? <p className="site-detail-panel__error">{notificationsError}</p> : null}
              </section>
            </>
          ) : (
            <>
              <header className="site-detail-page__header">
                <div>
                  <h1 id="userSettingsTitle">Billing</h1>
                </div>
              </header>

              <section className="site-detail-panel__api-key site-detail-page__section site-detail-page__section--flush">
                <div className="site-detail-page__section-heading">
                  <div>
                    <h3>Workspace usage</h3>
                    <p>Current dashboard footprint for this account.</p>
                  </div>
                </div>
                <div className="user-settings-page__metric-grid">
                  <UserSettingsMetric label="Identities" value={sites.length} />
                  <UserSettingsMetric label="Plan" value="Starter" />
                  <UserSettingsMetric label="Billing" value="Not configured" />
                </div>
              </section>

              <section className="site-detail-panel__api-key site-detail-page__section">
                <div className="site-detail-page__section-heading">
                  <div>
                    <h3>Plan management</h3>
                    <p>Upgrade and billing management will appear here when account billing is connected.</p>
                  </div>
                  <button className="site-detail-page__section-action" type="button" disabled>
                    Manage plan
                  </button>
                </div>
              </section>
            </>
          )}
          </div>
        </div>
      </section>

      {isPasswordModalOpen ? (
        <div
          className="user-settings-page__modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closePasswordModal();
            }
          }}
        >
          <form
            className="user-settings-page__password-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="passwordModalTitle"
            onSubmit={(event) => {
              event.preventDefault();
              void savePasswordSettings();
            }}
          >
            <header className="user-settings-page__modal-header">
              <div>
                <h2 id="passwordModalTitle">Change password</h2>
                <p>Update the password used to sign in to this dashboard.</p>
              </div>
              <button className="user-settings-page__modal-close" type="button" onClick={closePasswordModal} aria-label="Close password dialog">
                <X size={18} aria-hidden="true" />
              </button>
            </header>

            <div className="user-settings-page__password-fields">
              <label className="site-detail-page__field">
                <span>Current password</span>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
              </label>
              <label className="site-detail-page__field">
                <span>New password</span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <label className="site-detail-page__field">
                <span>Confirm password</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
            </div>

            {passwordError ? <p className="site-detail-panel__error">{passwordError}</p> : null}

            <footer className="user-settings-page__modal-actions">
              <button className="user-settings-page__modal-secondary" type="button" onClick={closePasswordModal} disabled={isSavingPassword}>
                Cancel
              </button>
              <button className="site-detail-page__section-action" type="submit" disabled={isSavingPassword}>
                {isSavingPassword ? "Updating" : "Update password"}
              </button>
            </footer>
          </form>
        </div>
      ) : null}
    </>
  );
}

function UserSettingsTab({
  section,
  activeSection,
  label,
  icon,
  onSectionChange
}: {
  section: UserSettingsSection;
  activeSection: UserSettingsSection;
  label: string;
  icon: "profile" | "security" | "notifications" | "billing";
  onSectionChange: (section: UserSettingsSection) => void;
}) {
  return (
    <button
      className="site-detail-page__tab"
      id={`user-settings-${section}-tab`}
      type="button"
      role="tab"
      aria-label={label}
      aria-selected={activeSection === section}
      aria-controls={`user-settings-${section}-panel`}
      onClick={() => onSectionChange(section)}
    >
      <SiteSettingsCategoryIcon icon={icon} />
      <span>{label}</span>
    </button>
  );
}

function UserSettingsInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="user-settings-page__info-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function UserSettingsMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="user-settings-page__metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function UserSettingsToggle({
  label,
  description,
  checked,
  onChange
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="user-settings-page__toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="user-settings-page__toggle-control" aria-hidden="true" />
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

function getUserInitials(displayName: string, email: string): string {
  const source = displayName.trim() || email;
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? email.charAt(0);
  const second = parts.length > 1 ? parts[1]?.charAt(0) : "";
  return `${first}${second}`.toUpperCase();
}

function formatProfileDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Recently";
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function SiteSettingsCategoryIcon({
  icon
}: {
  icon:
    | "general"
    | "openclaw"
    | "phone"
    | "act-on-behalf"
    | "email"
    | "profile"
    | "security"
    | "notifications"
    | "billing";
}) {
  if (icon === "profile") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 10.35a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4Zm0 1.65c-4.1 0-7.25 2.08-7.25 4.64 0 .78.63 1.41 1.41 1.41h11.68c.78 0 1.41-.63 1.41-1.41C17.25 14.08 14.1 12 10 12Z" />
      </svg>
    );
  }

  if (icon === "security") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 1.55 3.2 4.1v4.94c0 4.23 2.85 8.18 6.8 9.41 3.95-1.23 6.8-5.18 6.8-9.41V4.1L10 1.55Zm2.38 7.75-2.94 3.35a.82.82 0 0 1-1.21.03L6.74 11.2a.84.84 0 0 1 1.19-1.19l.85.85 2.34-2.67a.84.84 0 1 1 1.26 1.11Z" />
      </svg>
    );
  }

  if (icon === "notifications") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 18.25a2.16 2.16 0 0 0 2.05-1.5h-4.1A2.16 2.16 0 0 0 10 18.25ZM4.1 14.95h11.8c.67 0 1.05-.76.65-1.3l-.9-1.22V8.1a5.65 5.65 0 1 0-11.3 0v4.33l-.9 1.22c-.4.54-.02 1.3.65 1.3Z" />
      </svg>
    );
  }

  if (icon === "billing") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3.25 4.25A2.25 2.25 0 0 1 5.5 2h9a2.25 2.25 0 0 1 2.25 2.25v11.5A2.25 2.25 0 0 1 14.5 18h-9a2.25 2.25 0 0 1-2.25-2.25V4.25Zm2.4 2.3h8.7V5.1h-8.7v1.45Zm0 3.1h2.8V8.2h-2.8v1.45Zm4.95 0h3.75V8.2H10.6v1.45Zm-4.95 3.15h2.8v-1.45h-2.8v1.45Zm4.95 0h3.75v-1.45H10.6v1.45Z" />
      </svg>
    );
  }

  if (icon === "general") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M8.57 1.75h2.86l.52 2.18c.47.15.92.34 1.34.56l1.91-1.18 2.02 2.02-1.18 1.91c.22.42.41.87.56 1.34l2.18.52v2.86l-2.18.52c-.15.47-.34.92-.56 1.34l1.18 1.91-2.02 2.02-1.91-1.18c-.42.22-.87.41-1.34.56l-.52 2.18H8.57l-.52-2.18a7.1 7.1 0 0 1-1.34-.56L4.8 17.75l-2.02-2.02 1.18-1.91a7.1 7.1 0 0 1-.56-1.34l-2.18-.52V9.1l2.18-.52c.15-.47.34-.92.56-1.34L2.78 5.33 4.8 3.31l1.91 1.18c.42-.22.87-.41 1.34-.56l.52-2.18Zm1.43 5.8a2.45 2.45 0 1 0 0 4.9 2.45 2.45 0 0 0 0-4.9Z" />
      </svg>
    );
  }

  if (icon === "openclaw") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M10.5 3A1.501 1.501 0 0 0 9 4.5h6A1.5 1.5 0 0 0 13.5 3h-3Zm-2.693.178A3 3 0 0 1 10.5 1.5h3a3 3 0 0 1 2.694 1.678c.497.042.992.092 1.486.15 1.497.173 2.57 1.46 2.57 2.929V19.5a3 3 0 0 1-3 3H6.75a3 3 0 0 1-3-3V6.257c0-1.47 1.073-2.756 2.57-2.93.493-.057.989-.107 1.487-.15Z"
          clipRule="evenodd"
        />
      </svg>
    );
  }

  if (icon === "act-on-behalf") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M2.8 4.74c0-.76.84-1.22 1.48-.8l5.86 3.9c.55.37.55 1.18 0 1.54l-5.86 3.9a.96.96 0 0 1-1.48-.8V4.74Zm8.08 0c0-.76.85-1.22 1.48-.8l5.86 3.9c.55.37.55 1.18 0 1.54l-5.86 3.9a.96.96 0 0 1-1.48-.8V4.74Z" />
      </svg>
    );
  }

  if (icon === "phone") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5.32 2.1c.62-.29 1.36-.06 1.71.52l1.2 2c.31.52.25 1.18-.16 1.63l-.8.89a.46.46 0 0 0-.08.5 9.03 9.03 0 0 0 4.15 4.15.46.46 0 0 0 .5-.08l.89-.8c.45-.41 1.11-.47 1.63-.16l2 1.2c.58.35.81 1.09.52 1.71l-.9 1.94c-.29.62-.92 1-1.6.96C7.92 16.17 3.83 12.08 3.44 5.62c-.04-.68.34-1.31.96-1.6l.92-.42Z" />
      </svg>
    );
  }

  if (icon === "email") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h12a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5v-9Zm1.86-.1 5.64 4.02 5.64-4.02H4.36Zm11.14 1.1-5.07 3.61a1 1 0 0 1-1.16 0L4.2 6.5v8H15.8v-8Z" />
      </svg>
    );
  }

  return (
    <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M11.42 1.52c.65.17.99.88.71 1.49L9.75 8.2h5.02c.91 0 1.38 1.09.75 1.75l-7.67 8.05c-.48.5-1.32.04-1.15-.63l1.43-5.57H4.97c-.79 0-1.29-.84-.92-1.54l6.18-8.27c.24-.4.72-.59 1.19-.47Z" />
    </svg>
  );
}

function DeleteMinusCircleIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M16.5 4.47795V4.70495C17.799 4.82373 19.0927 4.99454 20.378 5.21695C20.4751 5.23376 20.5678 5.26952 20.6511 5.32218C20.7343 5.37485 20.8063 5.4434 20.8631 5.52391C20.9198 5.60441 20.9601 5.69531 20.9817 5.7914C21.0033 5.88749 21.0058 5.9869 20.989 6.08395C20.9722 6.181 20.9364 6.27378 20.8838 6.35701C20.8311 6.44023 20.7626 6.51227 20.682 6.56901C20.6015 6.62575 20.5106 6.66607 20.4146 6.68768C20.3185 6.70929 20.2191 6.71176 20.122 6.69495L19.913 6.65995L18.908 19.7299C18.8501 20.4835 18.5098 21.1875 17.9553 21.701C17.4008 22.2146 16.6728 22.4999 15.917 22.4999H8.08401C7.3282 22.4999 6.60026 22.2146 6.04573 21.701C5.4912 21.1875 5.15095 20.4835 5.09301 19.7299L4.08701 6.65995L3.87801 6.69495C3.78096 6.71176 3.68155 6.70929 3.58546 6.68768C3.48937 6.66607 3.39847 6.62575 3.31796 6.56901C3.15537 6.45443 3.04495 6.27994 3.01101 6.08395C2.97706 5.88795 3.02236 5.6865 3.13694 5.52391C3.25153 5.36131 3.42601 5.2509 3.62201 5.21695C4.90727 4.99427 6.20099 4.82347 7.50001 4.70495V4.47795C7.50001 2.91395 8.71301 1.57795 10.316 1.52695C11.4387 1.49102 12.5623 1.49102 13.685 1.52695C15.288 1.57795 16.5 2.91395 16.5 4.47795ZM10.364 3.02595C11.4547 2.99106 12.5463 2.99106 13.637 3.02595C14.39 3.04995 15 3.68395 15 4.47795V4.59095C13.0018 4.4696 10.9982 4.4696 9.00001 4.59095V4.47795C9.00001 3.68395 9.60901 3.04995 10.364 3.02595Z"
        clipRule="evenodd"
        fill="currentColor"
      />
    </svg>
  );
}

function BackChevronIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="6" height="9" viewBox="0 0 6 9" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M4.25 7.5L1 4.25L4.25 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SiteDetailOverlay({
  site,
  activeTab,
  apiKeys,
  onApiKeyCreated,
  onApiKeyDeleted,
  onSiteDetailLoaded,
  onSiteUpdated,
  onSiteDeleted,
  onNotify,
  onTabChange,
  onClose
}: {
  site: Site;
  activeTab: SiteDetailTab;
  apiKeys: SiteApiKey[];
  onApiKeyCreated: (apiKey: SiteApiKey) => void;
  onApiKeyDeleted: (apiKeyId: string) => void;
  onSiteDetailLoaded: (detail: SiteDetailResponse) => void;
  onSiteUpdated: (site: Site) => void;
  onSiteDeleted: (siteId: string) => void;
  onNotify: (notification: ToastNotificationInput) => void;
  onTabChange: (tab: SiteDetailTab) => void;
  onClose: () => void;
}) {
  const [draftName, setDraftName] = useState(site.name);
  const [draftDomain, setDraftDomain] = useState(site.domain);
  const [draftDescription, setDraftDescription] = useState("");
  const [isSavingSite, setIsSavingSite] = useState(false);
  const [siteSaveError, setSiteSaveError] = useState("");
  const [createdApiKeySecret, setCreatedApiKeySecret] = useState<{
    apiKeyId: string;
    secret: string;
  } | null>(null);
  const [apiKeyError, setApiKeyError] = useState("");
  const [isCreatingApiKey, setIsCreatingApiKey] = useState(false);
  const [deletingApiKeyId, setDeletingApiKeyId] = useState<string | null>(null);
  const [copiedApiKeyId, setCopiedApiKeyId] = useState<string | null>(null);
  const [isDeletingSite, setIsDeletingSite] = useState(false);
  const [siteDeleteError, setSiteDeleteError] = useState("");
  useEffect(() => {
    setDraftName(site.name);
    setDraftDomain(site.domain);
    setSiteSaveError("");
  }, [site.id, site.name, site.domain]);

  useEffect(() => {
    setDraftDescription("");
  }, [site.id]);

  async function copySnippet() {
    await navigator.clipboard.writeText(buildIdentityReceipt(site));
    onNotify({
      title: "Identity receipt copied"
    });
  }

  async function saveSiteSettings() {
    const nextName = draftName.trim();
    const nextDomain = draftDomain.trim();

    if (!nextName || !nextDomain) {
      setSiteSaveError("Identity name and OpenClaw endpoint are required.");
      return;
    }

    const updates: { name?: string; domain?: string } = {};
    if (nextName !== site.name) {
      updates.name = nextName;
    }
    if (nextDomain !== site.domain) {
      updates.domain = nextDomain;
    }

    if (Object.keys(updates).length === 0) {
      setSiteSaveError("");
      return;
    }

    setIsSavingSite(true);
    setSiteSaveError("");

    try {
      const [response] = await Promise.all([
        api.updateSite(site.id, updates),
        sleep(500)
      ]);
      onSiteUpdated(response.site);
      onNotify({
        title: "Identity settings saved"
      });
    } catch (saveError) {
      setSiteSaveError(getErrorMessage(saveError, "Could not save identity settings"));
    } finally {
      setIsSavingSite(false);
    }
  }

  async function createApiKey() {
    setApiKeyError("");
    setIsCreatingApiKey(true);

    try {
      const response = await api.createSiteApiKey(site.id);
      setCreatedApiKeySecret({
        apiKeyId: response.apiKey.id,
        secret: response.secret
      });
      onApiKeyCreated(response.apiKey);
      onNotify({
        title: "Link token created"
      });
    } catch (createError) {
      setApiKeyError(getErrorMessage(createError, "Could not create link token"));
    } finally {
      setIsCreatingApiKey(false);
    }
  }

  async function copyApiKey(apiKeyId: string, secret: string) {
    await navigator.clipboard.writeText(secret);
    setCopiedApiKeyId(apiKeyId);
    onNotify({
      title: "Link token copied"
    });
    window.setTimeout(() => setCopiedApiKeyId(null), 1400);
  }

  async function deleteApiKey(apiKeyId: string) {
    setApiKeyError("");
    setDeletingApiKeyId(apiKeyId);

    try {
      await api.deleteSiteApiKey(site.id, apiKeyId);
      if (createdApiKeySecret?.apiKeyId === apiKeyId) {
        setCreatedApiKeySecret(null);
      }
      onApiKeyDeleted(apiKeyId);
      onNotify({
        title: "Link token deleted"
      });
    } catch (deleteError) {
      setApiKeyError(getErrorMessage(deleteError, "Could not delete link token"));
    } finally {
      setDeletingApiKeyId(null);
    }
  }

  async function deleteSite() {
    const shouldDelete = window.confirm(`Delete ${site.name}? This cannot be undone.`);
    if (!shouldDelete) {
      return;
    }

    setSiteDeleteError("");
    setIsDeletingSite(true);

    try {
      await api.deleteSite(site.id);
      onSiteDeleted(site.id);
      onNotify({
        title: "Agent identity deleted"
      });
    } catch (deleteError) {
      setSiteDeleteError(getErrorMessage(deleteError, "Could not delete agent identity"));
      setIsDeletingSite(false);
    }
  }

  const normalizedDraftName = draftName.trim();
  const normalizedDraftDomain = draftDomain.trim();
  const hasSiteDraftChanges = normalizedDraftName !== site.name || normalizedDraftDomain !== site.domain;
  const isSaveDisabled = isSavingSite || !normalizedDraftName || !normalizedDraftDomain || !hasSiteDraftChanges;
  const previewDescription = draftDescription.trim() || "This OpenClaw agent can call, email, pay, schedule, and receive real-world events.";

  return (
    <section className="site-detail-page dashboard-page__workspace" aria-labelledby="siteDetailTitle">
      <div className="site-detail-page__shell">
        <aside className="site-detail-page__sidebar" aria-label="Agent identity sections">
          <button className="site-detail-page__back" type="button" onClick={onClose} aria-label="Back to identities">
            <BackChevronIcon />
          </button>

          <nav className="site-detail-page__tabs" role="tablist" aria-label="Agent identity details">
            <button
              className="site-detail-page__tab"
              id="site-detail-credentials-tab"
              type="button"
              role="tab"
              aria-label="Credentials"
              aria-selected={activeTab === "credentials"}
              aria-controls="site-detail-credentials-panel"
              onClick={() => onTabChange("credentials")}
            >
              <SiteSettingsCategoryIcon icon="general" />
              <span>General</span>
            </button>
            <button
              className="site-detail-page__tab"
              id="site-detail-openclaw-tab"
              type="button"
              role="tab"
              aria-label="OpenClaw"
              aria-selected={activeTab === "openclaw"}
              aria-controls="site-detail-openclaw-panel"
              onClick={() => onTabChange("openclaw")}
            >
              <SiteSettingsCategoryIcon icon="openclaw" />
              <span>OpenClaw</span>
            </button>
            <button
              className="site-detail-page__tab"
              id="site-detail-phone-tab"
              type="button"
              role="tab"
              aria-label="Phone"
              aria-selected={activeTab === "phone"}
              aria-controls="site-detail-phone-panel"
              onClick={() => onTabChange("phone")}
            >
              <SiteSettingsCategoryIcon icon="phone" />
              <span>Phone</span>
            </button>
            <button
              className="site-detail-page__tab"
              id="site-detail-payments-tab"
              type="button"
              role="tab"
              aria-label="Payments"
              aria-selected={activeTab === "payments"}
              aria-controls="site-detail-payments-panel"
              onClick={() => onTabChange("payments")}
            >
              <SiteSettingsCategoryIcon icon="act-on-behalf" />
              <span>Payments</span>
            </button>
            <button
              className="site-detail-page__tab"
              id="site-detail-email-tab"
              type="button"
              role="tab"
              aria-label="Email"
              aria-selected={activeTab === "email"}
              aria-controls="site-detail-email-panel"
              onClick={() => onTabChange("email")}
            >
              <SiteSettingsCategoryIcon icon="email" />
              <span>Email</span>
            </button>
          </nav>
        </aside>

        <div
          className="site-detail-page__content"
          key={activeTab}
          id={`site-detail-${activeTab}-panel`}
          role="tabpanel"
          aria-labelledby={`site-detail-${activeTab}-tab`}
        >
          {activeTab === "payments" ? (
            <PaymentsPanel siteId={site.id} siteName={site.name} />
          ) : activeTab === "email" ? (
            <EmailPanel siteId={site.id} siteName={site.name} />
          ) : activeTab === "phone" ? (
            <PhonePanel siteName={site.name} />
          ) : activeTab === "credentials" ? (
            <>
              <header className="site-detail-page__header">
                <div>
                  <h1 id="siteDetailTitle">Identity</h1>
                </div>
                <button
                  className={`site-detail-page__save${isSavingSite ? " site-detail-page__save--saving" : ""}`}
                  type="button"
                  onClick={() => void saveSiteSettings()}
                  disabled={isSaveDisabled}
                  aria-label={isSavingSite ? "Saving identity settings" : "Save identity settings"}
                >
                  {isSavingSite ? <Loader2 size={15} strokeWidth={3.2} aria-hidden="true" /> : <span>Save</span>}
                </button>
              </header>

              <div className="site-detail-page__form-grid">
                <label className="site-detail-page__field">
                  <span>Identity name</span>
                  <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
                </label>

                <label className="site-detail-page__field">
                  <span>OpenClaw endpoint</span>
                  <input value={draftDomain} onChange={(event) => setDraftDomain(event.target.value)} />
                </label>

                <label className="site-detail-page__field site-detail-page__field--textarea">
                  <span>Description</span>
                  <textarea
                    value={draftDescription}
                    onChange={(event) => setDraftDescription(event.target.value)}
                    placeholder="What this agent is allowed to do"
                  />
                </label>

                <div className="site-detail-page__preview" aria-label="Agent identity preview">
                  <span>Identity bundle</span>
                  <div className="site-detail-page__preview-card">
                    <Brand
                      className="site-detail-page__preview-brand"
                      label={normalizedDraftDomain || site.domain}
                      theme="light"
                    />
                    <strong>{normalizedDraftName || site.name}</strong>
                    <p>{previewDescription}</p>
                  </div>
                </div>
              </div>

              <section className="site-detail-page__section agent-identity-capabilities" aria-label="Provisioned real-world tools">
                {agentIdentityCapabilities.map(({ label, value, description, Icon }) => (
                  <article className="agent-identity-capabilities__item" key={label}>
                    <span className="agent-identity-capabilities__icon" aria-hidden="true">
                      <Icon size={17} strokeWidth={2.2} />
                    </span>
                    <div>
                      <strong>{label}</strong>
                      <span>{value}</span>
                      <small>{description}</small>
                    </div>
                  </article>
                ))}
              </section>

              {siteSaveError ? <p className="site-detail-panel__error">{siteSaveError}</p> : null}

              <section className="site-detail-panel__danger site-detail-page__section">
                <div>
                  <h3>Danger Zone</h3>
                  <p>Delete this identity, OpenClaw link tokens, API keys, generated docs, and interaction logs.</p>
                  {siteDeleteError ? <p className="site-detail-panel__error">{siteDeleteError}</p> : null}
                </div>
                <button
                  className="site-detail-panel__delete-site"
                  type="button"
                  onClick={() => void deleteSite()}
                  disabled={isDeletingSite}
                >
                  {isDeletingSite ? (
                    <Loader2 size={17} aria-hidden="true" />
                  ) : (
                    <DeleteMinusCircleIcon className="site-detail-page__delete-icon" />
                  )}
                  <span>{isDeletingSite ? "Deleting" : "Delete identity"}</span>
                </button>
              </section>
            </>
          ) : activeTab === "openclaw" ? (
            <>
              <header className="site-detail-page__header">
                <div>
                  <h1 id="siteDetailTitle">OpenClaw link</h1>
                </div>
              </header>

              <section className="site-detail-panel__receipt site-detail-page__section">
                <div className="site-detail-page__section-heading">
                  <div>
                    <h3>Identity layer receipt</h3>
                    <p>Use this demo receipt to verify the real-world tools attached to {site.name}.</p>
                  </div>
                  <div className="site-detail-page__section-actions">
                    <button
                      className="site-detail-page__section-action"
                      type="button"
                      onClick={copySnippet}
                    >
                      Copy receipt
                    </button>
                  </div>
                </div>
                <textarea readOnly value={buildIdentityReceipt(site)} spellCheck={false} />
              </section>

              <section className="site-detail-panel__api-key site-detail-page__section">
                <div className="site-detail-page__section-heading">
                  <div>
                    <h3>OpenClaw linking tokens</h3>
                    <p>Create a scoped token for an OpenClaw instance to confirm the Aidentity identity skill install.</p>
                  </div>
                  <button
                    className="site-detail-page__section-action"
                    type="button"
                    onClick={createApiKey}
                    disabled={isCreatingApiKey}
                  >
                    {isCreatingApiKey ? "Creating" : createdApiKeySecret ? "Create another token" : "Create link token"}
                  </button>
                </div>
                {apiKeys.length > 0 ? (
                  <div className="site-detail-panel__api-key-list">
                    {apiKeys.map((apiKey) => (
                      <div className="site-detail-panel__api-key-row" key={apiKey.id}>
                        <div>
                          <strong>{apiKey.name}</strong>
                          <span>{apiKey.prefix}••••••••••••</span>
                        </div>
                        <small>
                          {apiKey.lastUsedAt ? `Used ${formatSiteRelativeTime(apiKey.lastUsedAt)}` : "Never used"}
                        </small>
                        <div className="site-detail-panel__api-key-row-actions">
                          {createdApiKeySecret?.apiKeyId === apiKey.id ? (
                            <button
                              className="site-detail-panel__copy-key"
                              type="button"
                              onClick={() => void copyApiKey(apiKey.id, createdApiKeySecret.secret)}
                            >
                              {copiedApiKeyId === apiKey.id ? (
                                <Check size={16} aria-hidden="true" />
                              ) : (
                                <Copy size={16} aria-hidden="true" />
                              )}
                              <span>{copiedApiKeyId === apiKey.id ? "Copied" : "Copy token"}</span>
                            </button>
                          ) : null}
                          <button
                            className="site-detail-panel__delete-key"
                            type="button"
                            aria-label={`Delete ${apiKey.name}`}
                            title="Delete link token"
                            onClick={() => void deleteApiKey(apiKey.id)}
                            disabled={deletingApiKeyId === apiKey.id}
                          >
                            {deletingApiKeyId === apiKey.id ? (
                              <Loader2 size={16} aria-hidden="true" />
                            ) : (
                              <DeleteMinusCircleIcon className="site-detail-page__delete-icon" />
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {apiKeyError ? <p className="site-detail-panel__error">{apiKeyError}</p> : null}
              </section>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SetupProgressStepper({
  activeStep,
  completedSteps,
  stepProgress,
  steps = onboardingSetupSteps
}: {
  activeStep: SetupProgressStep | null;
  completedSteps: Set<SetupProgressStep>;
  stepProgress: SetupStepProgress;
  steps?: Array<{ id: SetupProgressStep; label: string }>;
}) {
  const currentStepIndex = activeStep
    ? steps.findIndex((step) => step.id === activeStep)
    : Math.max(0, completedSteps.size - 1);
  const lineProgress = steps.length <= 1 ? (completedSteps.size > 0 ? 1 : 0) : Math.min(completedSteps.size, steps.length - 1) / (steps.length - 1);

  return (
    <div
      className="setup-progress"
      style={
        {
          "--setup-progress-step-count": steps.length,
          "--setup-progress-line-progress": lineProgress
        } as CSSProperties
      }
      aria-label="Setup progress"
    >
      {steps.map((step, index) => {
        const isCompleted = completedSteps.has(step.id);
        const isActive = activeStep === step.id;
        const state = isCompleted ? "complete" : isActive ? "active" : index < currentStepIndex ? "complete" : "pending";
        const progress = stepProgress[step.id];
        const circleProgress = isCompleted
          ? 1
          : progress && progress.total > 0
            ? Math.max(0, Math.min(1, progress.current / progress.total))
            : 0;

        return (
          <div className={`setup-progress__step setup-progress__step--${state}`} key={step.id}>
            <div
              className="setup-progress__circle"
              style={{ "--setup-progress-circle-progress": `${circleProgress}turn` } as CSSProperties}
            >
              {isCompleted ? <Check size={15} aria-hidden="true" /> : <span>{index + 1}</span>}
            </div>
            <span className="setup-progress__label">{step.label}</span>
            {progress?.label ? <small className="setup-progress__detail">{progress.label}</small> : null}
          </div>
        );
      })}
    </div>
  );
}

function SiteOnboardingScreen({
  onCancel,
  onCreated
}: {
  onCancel: () => void;
  onCreated: (detail: SiteDetailResponse) => Promise<void>;
}) {
  const [step, setStep] = useState<SiteOnboardingStep>("name");
  const [displayStep, setDisplayStep] = useState<SiteOnboardingStep>("name");
  const [displayPanelState, setDisplayPanelState] = useState<PanelState>("active");
  const [transition, setTransition] = useState<StepTransition | null>(null);
  const [submittingStep, setSubmittingStep] = useState<SiteOnboardingStep | null>(null);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [openClawMode, setOpenClawMode] = useState<OpenClawConnectionMode>("existing");
  const [error, setError] = useState("");
  const [nameError, setNameError] = useState("");
  const [domainError, setDomainError] = useState("");
  const [setupError, setSetupError] = useState("");
  const [setupProjectId, setSetupProjectId] = useState<string | null>(null);
  const [createdSiteDetail, setCreatedSiteDetail] = useState<SiteDetailResponse | null>(null);
  const [createdApiKeySecret, setCreatedApiKeySecret] = useState<{ apiKeyId: string; secret: string } | null>(null);
  const [isApiKeyCopied, setIsApiKeyCopied] = useState(false);
  const [isPromptCopied, setIsPromptCopied] = useState(false);
  const [isPreparingSetup, setIsPreparingSetup] = useState(false);
  const [isSkippingSetup, setIsSkippingSetup] = useState(false);
  const [isWaitingForAgent, setIsWaitingForAgent] = useState(false);
  const [activeSetupStep, setActiveSetupStep] = useState<SetupProgressStep | null>(null);
  const [completedSetupSteps, setCompletedSetupSteps] = useState<Set<SetupProgressStep>>(() => new Set());
  const [setupStepProgress, setSetupStepProgress] = useState<SetupStepProgress>({});
  const [isReceiptCopied, setIsReceiptCopied] = useState(false);
  const currentStepRef = useRef<SiteOnboardingStep>("name");
  const displayStepRef = useRef<SiteOnboardingStep>("name");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const domainInputRef = useRef<HTMLInputElement>(null);
  const setupHeadingRef = useRef<HTMLHeadingElement>(null);
  const installHeadingRef = useRef<HTMLHeadingElement>(null);
  const finishHeadingRef = useRef<HTMLHeadingElement>(null);
  const submitTimeoutRef = useRef<number | null>(null);
  const transitionSwapTimeoutRef = useRef<number | null>(null);
  const transitionFinishTimeoutRef = useRef<number | null>(null);
  const apiKeyCopiedTimeoutRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (submitTimeoutRef.current !== null) {
        window.clearTimeout(submitTimeoutRef.current);
      }
      if (transitionSwapTimeoutRef.current !== null) {
        window.clearTimeout(transitionSwapTimeoutRef.current);
      }
      if (transitionFinishTimeoutRef.current !== null) {
        window.clearTimeout(transitionFinishTimeoutRef.current);
      }
      if (apiKeyCopiedTimeoutRef.current !== null) {
        window.clearTimeout(apiKeyCopiedTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    currentStepRef.current = step;
  }, [step]);

  useEffect(() => {
    displayStepRef.current = displayStep;
  }, [displayStep]);

  useEffect(() => {
    if (displayStep === "name") {
      nameInputRef.current?.focus();
      return;
    }
    if (displayStep === "openclaw") {
      domainInputRef.current?.focus();
      return;
    }
    if (displayStep === "setup") {
      setupHeadingRef.current?.focus();
      return;
    }
    if (displayStep === "install") {
      installHeadingRef.current?.focus();
      return;
    }
    finishHeadingRef.current?.focus();
  }, [displayStep]);

  function transitionToStep(nextStep: SiteOnboardingStep) {
    const currentStep = transition?.to ?? currentStepRef.current;
    if (nextStep === currentStep) {
      return;
    }

    if (transitionSwapTimeoutRef.current !== null) {
      window.clearTimeout(transitionSwapTimeoutRef.current);
    }
    if (transitionFinishTimeoutRef.current !== null) {
      window.clearTimeout(transitionFinishTimeoutRef.current);
    }

    currentStepRef.current = nextStep;
    setStep(nextStep);
    setTransition({ from: displayStepRef.current, to: nextStep });
    setDisplayPanelState("outgoing");
    transitionSwapTimeoutRef.current = window.setTimeout(() => {
      displayStepRef.current = nextStep;
      setDisplayStep(nextStep);
      setDisplayPanelState("incoming");
      transitionSwapTimeoutRef.current = null;
      transitionFinishTimeoutRef.current = window.setTimeout(() => {
        setDisplayPanelState("active");
        setTransition(null);
        transitionFinishTimeoutRef.current = null;
      }, onboardingPanelTransitionDurationMs - onboardingPanelTransitionSwapMs);
    }, onboardingPanelTransitionSwapMs);
  }

  function runStep(event: FormEvent, currentStep: SiteOnboardingStep, nextStep: SiteOnboardingStep) {
    event.preventDefault();
    if (submittingStep !== null || transition !== null) {
      return;
    }

    if (currentStep === "name" && !name.trim()) {
      setNameError(requiredFieldMessage);
      nameInputRef.current?.focus();
      return;
    }

    if (submitTimeoutRef.current !== null) {
      window.clearTimeout(submitTimeoutRef.current);
    }

    setSubmittingStep(currentStep);
    submitTimeoutRef.current = window.setTimeout(() => {
      setSubmittingStep(null);
      transitionToStep(nextStep);
      submitTimeoutRef.current = null;
    }, buttonLoadingDurationMs);
  }

  async function startSetup(event: FormEvent) {
    event.preventDefault();
    if (submittingStep !== null || isPreparingSetup) {
      return;
    }

    if (openClawMode === "existing" && !domain.trim()) {
      setDomainError(requiredFieldMessage);
      domainInputRef.current?.focus();
      return;
    }

    const normalizedEndpoint = openClawMode === "existing"
      ? domain.trim()
      : `${slugifyIdentityName(name)}.managed-openclaw.aidentity.space`;

    setDomain(normalizedEndpoint);
    setSubmittingStep("openclaw");
    setIsPreparingSetup(true);
    setError("");
    setDomainError("");
    setSetupError("");
    let preparedProjectId = setupProjectId;
    try {
      const setupResponse = preparedProjectId ? null : await api.createSiteSetup(name.trim(), normalizedEndpoint);
      preparedProjectId = preparedProjectId ?? setupResponse?.setup.projectId ?? null;
      if (!isMountedRef.current) {
        return;
      }

      if (setupResponse) {
        setSetupProjectId(setupResponse.setup.projectId);
        setCreatedApiKeySecret({
          apiKeyId: setupResponse.apiKey.id,
          secret: setupResponse.secret
        });
        setIsApiKeyCopied(false);
      }

      if (!preparedProjectId) {
        throw new Error("Could not create setup project.");
      }

      setSubmittingStep(null);
      setIsPreparingSetup(false);
      transitionToStep("setup");
      if (openClawMode === "deploy") {
        void completeManagedOpenClawSetup(preparedProjectId);
      } else {
        showOpenClawWaitingState();
      }
    } catch (setupStartError) {
      if (preparedProjectId) {
        setSetupProjectId(preparedProjectId);
        setSetupError(getErrorMessage(setupStartError, "Could not prepare this OpenClaw link"));
        transitionToStep("setup");
      } else {
        setError(getErrorMessage(setupStartError, "Could not create agent identity"));
      }
    } finally {
      setSubmittingStep(null);
      setIsPreparingSetup(false);
    }
  }

  function showOpenClawWaitingState() {
    setIsWaitingForAgent(true);
    setActiveSetupStep("connection");
    setCompletedSetupSteps(new Set());
    setSetupStepProgress({
      connection: { current: 0, total: 1, label: "Waiting for OpenClaw skill confirmation" }
    });
  }

  async function completeManagedOpenClawSetup(projectId: string) {
    setIsWaitingForAgent(true);
    setActiveSetupStep("connection");
    setCompletedSetupSteps(new Set());
    setSetupStepProgress({
      connection: { current: 0, total: 1, label: "Deploying managed OpenClaw instance" }
    });

    try {
      await sleep(1400);
      if (!isMountedRef.current) {
        return;
      }
      setSetupStepProgress({
        connection: { current: 1, total: 1, label: "Managed OpenClaw deployed" }
      });
      setCompletedSetupSteps(new Set(["connection"]));
      await completeIdentitySetup(projectId);
    } catch (deployError) {
      setSetupError(getErrorMessage(deployError, "Could not deploy managed OpenClaw"));
      setIsWaitingForAgent(false);
    }
  }

  async function completeIdentitySetup(projectId: string) {
    setIsSkippingSetup(true);
    setSetupError("");

    try {
      const finalDetail = await api.completeSiteSetup(projectId);
      if (!isMountedRef.current) {
        return;
      }

      setCreatedSiteDetail(finalDetail);
      setIsWaitingForAgent(false);
      setIsSkippingSetup(false);
      setActiveSetupStep(null);
      transitionToStep("install");
    } catch (completeError) {
      setSetupError(getErrorMessage(completeError, "Could not finish agent identity setup"));
      setIsWaitingForAgent(false);
      setIsSkippingSetup(false);
    }
  }

  async function retryOpenClawSetup() {
    if (!setupProjectId || isWaitingForAgent) {
      return;
    }

    setSetupError("");
    if (openClawMode === "deploy") {
      await completeManagedOpenClawSetup(setupProjectId);
      return;
    }

    showOpenClawWaitingState();
  }

  async function completeExistingOpenClawSetup() {
    if (!setupProjectId || isSkippingSetup) {
      return;
    }

    await completeIdentitySetup(setupProjectId);
  }

  async function copyConnectCommand() {
    if (!createdApiKeySecret) {
      return;
    }

    await navigator.clipboard.writeText(createdApiKeySecret.secret);
    setIsApiKeyCopied(true);
    if (apiKeyCopiedTimeoutRef.current !== null) {
      window.clearTimeout(apiKeyCopiedTimeoutRef.current);
    }
    apiKeyCopiedTimeoutRef.current = window.setTimeout(() => {
      setIsApiKeyCopied(false);
      apiKeyCopiedTimeoutRef.current = null;
    }, 1400);
  }

  async function copyOpenClawPrompt() {
    await navigator.clipboard.writeText(buildOpenClawLinkPrompt(name, createdApiKeySecret?.secret, setupProjectId));
    setIsPromptCopied(true);
    window.setTimeout(() => setIsPromptCopied(false), 1400);
  }

  async function copyOnboardingReceipt() {
    if (!createdSiteDetail) {
      return;
    }

    await navigator.clipboard.writeText(buildIdentityReceipt(createdSiteDetail.site));
    setIsReceiptCopied(true);
    window.setTimeout(() => setIsReceiptCopied(false), 1400);
  }

  async function finishOnboarding() {
    if (!createdSiteDetail) {
      return;
    }

    await onCreated(createdSiteDetail);
  }

  const currentProgressIndex = siteStepIndexes[step];
  const isCompletionDisplayStep = isCompletionOnboardingStep(displayStep);
  const completionBackdropState = displayStep === "finish" ? "active" : "hidden";
  const flowLayoutClass = isCompletionDisplayStep
    ? "site-onboarding-page__flow site-onboarding-page__flow--completion"
    : "site-onboarding-page__flow site-onboarding-page__flow--compact";
  const setupRetryLabel = setupError && isTimeoutLikeSetupError(setupError)
    ? "Timed out - retry OpenClaw link"
    : "Retry OpenClaw link";
  const shouldShowSetupErrorText = Boolean(setupError) && !isTimeoutLikeSetupError(setupError);
  const visibleConnectCommand = createdApiKeySecret ? "link token: ck_••••••••" : "Creating link token...";
  const openClawPrompt = buildOpenClawLinkPrompt(name, createdApiKeySecret?.secret, setupProjectId);
  const setupTitle = openClawMode === "deploy" ? "Deploying OpenClaw" : "Link existing OpenClaw";
  const setupDescription = openClawMode === "deploy"
    ? "We are deploying a managed OpenClaw instance and installing the Aidentity identity layer."
    : "Send this prompt to your OpenClaw instance. It installs the Aidentity identity skill and confirms the link with a token.";
  const readyReceipt = buildIdentityReceipt(createdSiteDetail?.site ?? null);

  return (
    <main className="site-onboarding-page" aria-label="Create agent identity">
      <div className="site-onboarding-page__canvas">
        <div className="site-onboarding-page__dark-plane" aria-hidden="true" />
        <section className="site-onboarding-page__board">
          <div className={`site-onboarding-page__completion-backdrop site-onboarding-page__completion-backdrop--${completionBackdropState}`} />

          <Brand className="site-onboarding-page__brand" />

          <div className="site-onboarding-page__progress" aria-label="Create agent identity progress">
            {siteProgressSteps.map((progressStep) => (
              <span
                key={progressStep}
                className={
                  progressStep <= currentProgressIndex
                    ? "site-onboarding-page__progress-step site-onboarding-page__progress-step--active"
                    : "site-onboarding-page__progress-step"
                }
              />
            ))}
          </div>

          <button className="site-onboarding-page__close" type="button" onClick={onCancel} aria-label="Close">
            <X size={17} aria-hidden="true" />
          </button>

          <section className={flowLayoutClass}>
            <div className="site-onboarding-page__stage">
              <OnboardingPanel state={displayPanelState}>
                {displayStep === "name" ? (
                  <>
                    <OnboardingHeader
                      title="Create an agent identity"
                      description="Give this real-world identity a name you will recognize in your dashboard."
                    />
                    <form className="site-onboarding-page__form" onSubmit={(event) => runStep(event, "name", "openclaw")} noValidate>
                      <div className="site-onboarding-page__sequence-item" style={getStaggerStyle(2)}>
                        <FloatingField
                          ref={nameInputRef}
                          autoComplete="off"
                          errorMessage={nameError}
                          label="Identity name"
                          name="identityName"
                          value={name}
                          onChange={(nextName) => {
                            setName(nextName);
                            setNameError("");
                          }}
                        />
                      </div>
                      <OnboardingSubmitAction isLoading={submittingStep === "name"} />
                    </form>
                  </>
                ) : null}

                {displayStep === "openclaw" ? (
                  <>
                    <OnboardingHeader
                      title="Connect OpenClaw"
                      description="Use an existing OpenClaw instance, or let Aidentity deploy one with the identity layer already installed."
                    />
                    <form className="site-onboarding-page__form" onSubmit={startSetup} noValidate>
                      <div className="site-onboarding-page__sequence-item site-onboarding-page__mode-grid" style={getStaggerStyle(2)}>
                        <button
                          className={`site-onboarding-page__mode-card${openClawMode === "existing" ? " site-onboarding-page__mode-card--active" : ""}`}
                          type="button"
                          aria-pressed={openClawMode === "existing"}
                          onClick={() => setOpenClawMode("existing")}
                        >
                          <Server size={18} aria-hidden="true" />
                          <strong>Existing instance</strong>
                          <span>Paste a prompt into OpenClaw and wait for the skill to confirm linking.</span>
                        </button>
                        <button
                          className={`site-onboarding-page__mode-card${openClawMode === "deploy" ? " site-onboarding-page__mode-card--active" : ""}`}
                          type="button"
                          aria-pressed={openClawMode === "deploy"}
                          onClick={() => {
                            setOpenClawMode("deploy");
                            setDomainError("");
                          }}
                        >
                          <Zap size={18} aria-hidden="true" />
                          <strong>Deploy for me</strong>
                          <span>Provision a managed OpenClaw instance with the identity layer preinstalled.</span>
                        </button>
                      </div>
                      <div className="site-onboarding-page__sequence-item" style={getStaggerStyle(2)}>
                        {openClawMode === "existing" ? (
                          <FloatingField
                            ref={domainInputRef}
                            autoComplete="url"
                            errorMessage={domainError}
                            label="OpenClaw endpoint"
                            name="openClawEndpoint"
                            placeholder="https://openclaw.example.com"
                            value={domain}
                            onChange={(nextDomain) => {
                              setDomain(nextDomain);
                              setDomainError("");
                            }}
                          />
                        ) : (
                          <div className="site-onboarding-page__managed-note">
                            <Server size={16} aria-hidden="true" />
                            <span>{`${slugifyIdentityName(name)}.managed-openclaw.aidentity.space`}</span>
                          </div>
                        )}
                      </div>
                      {error ? <p className="site-onboarding-page__submit-error">{error}</p> : null}
                      <OnboardingSubmitAction
                        isLoading={submittingStep === "openclaw" || isPreparingSetup}
                        label={openClawMode === "deploy" ? "Deploy identity" : "Create link prompt"}
                      />
                    </form>
                  </>
                ) : null}

                {displayStep === "setup" ? (
                  <>
                    <OnboardingHeader
                      headingRef={setupHeadingRef}
                      isProgrammaticallyFocusable
                      title={setupTitle}
                      description={setupDescription}
                    />
                    <div className="site-onboarding-page__setup">
                      <div className="site-onboarding-page__sequence-item site-onboarding-page__secret-card" style={getStaggerStyle(2)}>
                        <code>{visibleConnectCommand}</code>
                        <button
                          className="site-onboarding-page__inline-action"
                          type="button"
                          onClick={() => void copyConnectCommand()}
                          disabled={!createdApiKeySecret}
                        >
                          {isApiKeyCopied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                          <span>{isApiKeyCopied ? "Copied" : "Copy token"}</span>
                        </button>
                      </div>

                      {openClawMode === "existing" ? (
                        <div className="site-onboarding-page__sequence-item site-onboarding-page__prompt-card" style={getStaggerStyle(3)}>
                          <pre>{openClawPrompt}</pre>
                          <button
                            className="site-onboarding-page__inline-action"
                            type="button"
                            onClick={() => void copyOpenClawPrompt()}
                          >
                            {isPromptCopied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                            <span>{isPromptCopied ? "Copied" : "Copy prompt"}</span>
                          </button>
                        </div>
                      ) : null}

                      <div className="site-onboarding-page__sequence-item" style={getStaggerStyle(openClawMode === "existing" ? 4 : 3)}>
                        <SetupProgressStepper
                          activeStep={activeSetupStep}
                          completedSteps={completedSetupSteps}
                          stepProgress={setupStepProgress}
                          steps={onboardingSetupSteps}
                        />
                      </div>

                      {shouldShowSetupErrorText ? (
                        <p className="site-onboarding-page__sequence-item site-onboarding-page__submit-error" style={getStaggerStyle(4)}>
                          {setupError}
                        </p>
                      ) : null}
                      {setupError ? (
                        <button
                          className="site-onboarding-page__sequence-item site-onboarding-page__inline-action site-onboarding-page__inline-action--wide"
                          style={getStaggerStyle(5)}
                          type="button"
                          onClick={() => void retryOpenClawSetup()}
                        >
                          <FileText size={16} aria-hidden="true" />
                          <span>{setupRetryLabel}</span>
                        </button>
                      ) : null}
                      <div
                        className="site-onboarding-page__sequence-item site-onboarding-page__action site-onboarding-page__action--form-width"
                        style={getStaggerStyle(setupError ? 6 : 4)}
                      >
                        <button
                          className={
                            isSkippingSetup
                              ? "site-onboarding-page__submit site-onboarding-page__submit--secondary site-onboarding-page__submit--loading"
                              : "site-onboarding-page__submit site-onboarding-page__submit--secondary"
                          }
                          type="button"
                          onClick={() => void completeExistingOpenClawSetup()}
                          disabled={!setupProjectId || isSkippingSetup}
                          aria-busy={isSkippingSetup}
                        >
                          {isSkippingSetup ? (
                            <span className="aidentity-button-loader" aria-hidden="true" />
                          ) : (
                            <span>{openClawMode === "existing" ? "Demo: mark linked" : "Continue"}</span>
                          )}
                        </button>
                      </div>
                    </div>
                  </>
                ) : null}

                {displayStep === "install" ? (
                  <>
                    <OnboardingHeader
                      headingRef={installHeadingRef}
                      isProgrammaticallyFocusable
                      title="Identity ready"
                      description="This agent identity now has a phone number, inbox, payment card, calendar, and OpenClaw link."
                    />
                    <div className="site-onboarding-page__ready">
                      <div className="site-onboarding-page__sequence-item site-onboarding-page__secret-card site-onboarding-page__receipt-card" style={getStaggerStyle(2)}>
                        <code>{createdSiteDetail ? readyReceipt : "Provisioning identity..."}</code>
                        <button
                          className="site-onboarding-page__inline-action"
                          type="button"
                          onClick={() => void copyOnboardingReceipt()}
                          disabled={!createdSiteDetail}
                        >
                          {isReceiptCopied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                          <span>{isReceiptCopied ? "Copied" : "Copy receipt"}</span>
                        </button>
                      </div>
                      <div className="site-onboarding-page__sequence-item agent-identity-capabilities agent-identity-capabilities--onboarding" style={getStaggerStyle(3)}>
                        {agentIdentityCapabilities.map(({ label, value, Icon }) => (
                          <article className="agent-identity-capabilities__item" key={label}>
                            <span className="agent-identity-capabilities__icon" aria-hidden="true">
                              <Icon size={16} strokeWidth={2.2} />
                            </span>
                            <div>
                              <strong>{label}</strong>
                              <span>{value}</span>
                            </div>
                          </article>
                        ))}
                      </div>
                      <div className="site-onboarding-page__sequence-item site-onboarding-page__action" style={getStaggerStyle(3)}>
                        <button
                          className="site-onboarding-page__submit"
                          type="button"
                          onClick={() => transitionToStep("finish")}
                          disabled={!createdSiteDetail}
                        >
                          <span>Continue</span>
                        </button>
                      </div>
                    </div>
                  </>
                ) : null}

                {displayStep === "finish" ? (
                  <>
                    <OnboardingHeader
                      headingRef={finishHeadingRef}
                      isProgrammaticallyFocusable
                      title="You're all set"
                      description="Return to the dashboard to manage this agent identity and its real-world tools."
                    />
                    <div className="site-onboarding-page__finish">
                      <button
                        className="site-onboarding-page__submit"
                        type="button"
                        onClick={() => void finishOnboarding()}
                        disabled={!createdSiteDetail}
                      >
                        <span>Back to dashboard</span>
                      </button>
                    </div>
                  </>
                ) : null}
              </OnboardingPanel>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}

function OnboardingPanel({ state, children }: { state: PanelState; children: ReactNode }) {
  return (
    <section className={`site-onboarding-page__panel site-onboarding-page__panel--${state}`} aria-hidden={state !== "active"}>
      {children}
    </section>
  );
}

function OnboardingHeader({
  title,
  description,
  headingRef,
  isProgrammaticallyFocusable = false
}: {
  title: ReactNode;
  description: ReactNode;
  headingRef?: React.Ref<HTMLHeadingElement>;
  isProgrammaticallyFocusable?: boolean;
}) {
  return (
    <header className="site-onboarding-page__header">
      <h1
        ref={headingRef}
        className="site-onboarding-page__sequence-item"
        tabIndex={isProgrammaticallyFocusable ? -1 : undefined}
        style={getStaggerStyle(0)}
      >
        {title}
      </h1>
      <p className="site-onboarding-page__sequence-item" style={getStaggerStyle(1)}>
        {description}
      </p>
    </header>
  );
}

function OnboardingSubmitAction({ isLoading = false, label = "Continue" }: { isLoading?: boolean; label?: string }) {
  return (
    <div className="site-onboarding-page__sequence-item site-onboarding-page__action" style={getStaggerStyle(3)}>
      <button
        className={
          isLoading
            ? "site-onboarding-page__submit site-onboarding-page__submit--loading"
            : "site-onboarding-page__submit"
        }
        type="submit"
        disabled={isLoading}
        aria-busy={isLoading}
      >
        {isLoading ? <span className="aidentity-button-loader" aria-hidden="true" /> : <span>{label}</span>}
      </button>
    </div>
  );
}
