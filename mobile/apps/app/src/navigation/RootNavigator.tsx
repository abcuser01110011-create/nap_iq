import React from "react";
import { ActivityIndicator, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import type { Assignment } from "@nap-iq/api-client";
import { useAuth } from "../auth/AuthContext";
import { OfflineProvider } from "../offline/OfflineContext";
import NotificationRouter from "../notifications/NotificationRouter";
import { navigationRef } from "./navigationRef";
import { colors as sharedColors } from "../theme/shared";
import { colors as customerColors } from "../theme/customer";
import { colors as technicianColors } from "../theme/technician";
import LoginScreen from "../screens/LoginScreen";

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

/* ---------------------------------- Customer ---------------------------------- */

export type CustomerStackParamList = {
  Tabs: undefined;
  ReportIssue: undefined;
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

function CustomerTabs() {
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
      <CustomerTab.Screen name="Issues" component={CustomerIssuesScreen} />
      <CustomerTab.Screen name="Requests" component={ServiceRequestsScreen} options={{ title: "Requests" }} />
      <CustomerTab.Screen name="Payments" component={PaymentsScreen} />
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
    // No navigator needed for a single screen — LoginScreen doesn't
    // use any navigation prop.
    return (
      <>
        <StatusBar style="light" />
        <LoginScreen />
      </>
    );
  }

  return role === "technician" ? <TechnicianApp /> : <CustomerApp />;
}
