import React, { useCallback, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer, useFocusEffect } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { ApiError, type Assignment } from "@nap-iq/api-client";
import { useAuth } from "../auth/AuthContext";
import { OfflineProvider } from "../offline/OfflineContext";
import NotificationRouter from "../notifications/NotificationRouter";
import { navigationRef } from "./navigationRef";
import { colors as sharedColors } from "../theme/shared";
import { colors as customerColors } from "../theme/customer";
import { colors as technicianColors } from "../theme/technician";
import LoginScreen from "../screens/LoginScreen";
import RegisterScreen from "../screens/RegisterScreen";
import ApplyForServiceScreen from "../screens/ApplyForServiceScreen";

// Customer screens
import HomeScreen from "../screens/customer/HomeScreen";
import CustomerIssuesScreen from "../screens/customer/IssuesScreen";
import ReportIssueScreen from "../screens/customer/ReportIssueScreen";
import ServiceRequestsScreen from "../screens/customer/ServiceRequestsScreen";
import PaymentsScreen from "../screens/customer/PaymentsScreen";
import CustomerProfileScreen from "../screens/customer/ProfileScreen";

// Technician screens
import AssignmentsScreen from "../screens/technician/AssignmentsScreen";
import HistoryScreen from "../screens/technician/HistoryScreen";
import JobDetailScreen from "../screens/technician/JobDetailScreen";
import TechnicianProfileScreen from "../screens/technician/ProfileScreen";

/* ------------------------------- Signed-out (auth) ----------------------------- */

export type AuthStackParamList = {
  Login: undefined;
  // Phase 30: pure username + password — see RegisterScreen. No
  // longer carries anything forward via route params; a successful
  // register() signs the account straight in and RootNavigator below
  // switches to CustomerApp on its own. Applying for service (name,
  // install address, plan, etc.) now happens from there, once signed
  // in — see CustomerStackParamList's ApplyForService below.
  Register: undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();

function AuthFlow() {
  return (
    <NavigationContainer>
      <StatusBar style="light" />
      {/* animation: "slide_from_right" makes pushing Register slide
          the new screen in from the right (Login appears to slide
          left underneath it), and — since native-stack automatically
          reverses a screen's own transition on the way back out —
          popping back to Login via "Already have an account?" slides
          Register back out to the right. Set once here rather than
          per-screen so both directions always stay in sync, and so
          it's consistent across iOS/Android instead of relying on
          each platform's differing default. */}
      <AuthStack.Navigator screenOptions={{ headerShown: false, animation: "slide_from_right" }}>
        <AuthStack.Screen name="Login" component={LoginScreen} />
        <AuthStack.Screen name="Register" component={RegisterScreen} />
      </AuthStack.Navigator>
    </NavigationContainer>
  );
}

/* ---------------------------------- Customer ---------------------------------- */

export type CustomerStackParamList = {
  Tabs: undefined;
  ReportIssue: undefined;
  // Phase 30: reached from HomeScreen's "Apply for service" prompt,
  // shown whenever the signed-in account has no subscriber yet. No
  // longer needs username/password route params — the account
  // already exists and is signed in by the time this screen opens.
  ApplyForService: undefined;
};

export type CustomerTabParamList = {
  Home: undefined;
  Issues: undefined;
  Requests: undefined;
  Payments: undefined;
  Profile: undefined;
};

const CustomerStack = createNativeStackNavigator<CustomerStackParamList>();
const CustomerTab = createBottomTabNavigator<CustomerTabParamList>();

const CUSTOMER_TAB_ICONS: Record<keyof CustomerTabParamList, keyof typeof Ionicons.glyphMap> = {
  Home: "home-outline",
  Issues: "alert-circle-outline",
  Requests: "document-text-outline",
  Payments: "card-outline",
  Profile: "person-outline",
};

// Phase 31: a signed-in account with no subscriber record yet (see
// HomeScreen's NoSubscriberCard/"Apply for service") hasn't been
// linked to real service — Issues, Requests, and Payments all 404 for
// it server-side (app/routes/api_v1/customer.py), and Report Issue
// (reached from the Issues tab) would just dead-end the same way. So
// those tabs — and the Report Issue screen they're the only way to
// reach — stay hidden until the account has a subscriber on file.
// Re-checked every time this screen regains focus (e.g. coming back
// from Apply for service) so the extra tabs appear the moment an
// application is submitted, without waiting for a full app restart.
function CustomerTabs() {
  const { client } = useAuth();
  const [status, setStatus] = useState<"loading" | "linked" | "unlinked">("loading");

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      client.customer
        .me()
        .then(() => {
          if (!cancelled) setStatus("linked");
        })
        .catch((err) => {
          if (cancelled) return;
          if (err instanceof ApiError && err.status === 404) {
            setStatus("unlinked");
          } else {
            // Network hiccup or unexpected error — don't guess at
            // linked status from this; keep whatever we last knew
            // instead of flashing tabs away, only defaulting to
            // "unlinked" on the very first check.
            setStatus((prev) => (prev === "loading" ? "unlinked" : prev));
          }
        });
      return () => {
        cancelled = true;
      };
    }, [client])
  );

  if (status === "loading") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: customerColors.bg }}>
        <ActivityIndicator color={customerColors.primary} size="large" />
      </View>
    );
  }

  return (
    <CustomerTab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: customerColors.primary,
        tabBarInactiveTintColor: customerColors.textFaint,
        tabBarStyle: { borderTopColor: customerColors.border },
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={CUSTOMER_TAB_ICONS[route.name as keyof CustomerTabParamList]} size={size} color={color} />
        ),
      })}
    >
      <CustomerTab.Screen name="Home" component={HomeScreen} />
      {status === "linked" && (
        <>
          <CustomerTab.Screen name="Issues" component={CustomerIssuesScreen} />
          <CustomerTab.Screen name="Requests" component={ServiceRequestsScreen} options={{ title: "Requests" }} />
          <CustomerTab.Screen name="Payments" component={PaymentsScreen} />
        </>
      )}
      <CustomerTab.Screen name="Profile" component={CustomerProfileScreen} />
    </CustomerTab.Navigator>
  );
}

function CustomerApp() {
  return (
    <NavigationContainer>
      <StatusBar style="dark" />
      <CustomerStack.Navigator>
        <CustomerStack.Screen name="Tabs" component={CustomerTabs} options={{ headerShown: false }} />
        <CustomerStack.Screen
          name="ReportIssue"
          component={ReportIssueScreen}
          options={{ presentation: "modal", headerShown: false }}
        />
        <CustomerStack.Screen
          name="ApplyForService"
          component={ApplyForServiceScreen}
          options={{ presentation: "modal", headerShown: false }}
        />
      </CustomerStack.Navigator>
    </NavigationContainer>
  );
}

/* --------------------------------- Technician --------------------------------- */

export type TechnicianStackParamList = {
  Tabs: undefined;
  JobDetail: { assignment: Assignment };
};

export type TechnicianTabParamList = {
  Jobs: undefined;
  History: undefined;
  Profile: undefined;
};

const TechnicianStack = createNativeStackNavigator<TechnicianStackParamList>();
const TechnicianTab = createBottomTabNavigator<TechnicianTabParamList>();

const TECHNICIAN_TAB_ICONS: Record<keyof TechnicianTabParamList, keyof typeof Ionicons.glyphMap> = {
  Jobs: "briefcase-outline",
  History: "time-outline",
  Profile: "person-outline",
};

function TechnicianTabs() {
  return (
    <TechnicianTab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: technicianColors.primary,
        tabBarInactiveTintColor: technicianColors.textFaint,
        tabBarStyle: { backgroundColor: technicianColors.card, borderTopColor: technicianColors.border },
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={TECHNICIAN_TAB_ICONS[route.name as keyof TechnicianTabParamList]} size={size} color={color} />
        ),
      })}
    >
      <TechnicianTab.Screen name="Jobs" component={AssignmentsScreen} />
      <TechnicianTab.Screen name="History" component={HistoryScreen} />
      <TechnicianTab.Screen name="Profile" component={TechnicianProfileScreen} />
    </TechnicianTab.Navigator>
  );
}

function TechnicianApp() {
  return (
    <OfflineProvider>
      <NavigationContainer ref={navigationRef}>
        <StatusBar style="light" />
        <NotificationRouter />
        <TechnicianStack.Navigator screenOptions={{ headerShown: false }}>
          <TechnicianStack.Screen name="Tabs" component={TechnicianTabs} />
          <TechnicianStack.Screen name="JobDetail" component={JobDetailScreen} />
        </TechnicianStack.Navigator>
      </NavigationContainer>
    </OfflineProvider>
  );
}

/* ----------------------------------- Root ----------------------------------- */

export default function RootNavigator() {
  const { status, role } = useAuth();

  if (status === "loading") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: sharedColors.bg }}>
        <StatusBar style="light" />
        <ActivityIndicator color={sharedColors.primary} size="large" />
      </View>
    );
  }

  if (status !== "signedIn" || !role) {
    return <AuthFlow />;
  }

  return role === "technician" ? <TechnicianApp /> : <CustomerApp />;
}
