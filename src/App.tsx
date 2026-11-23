
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { supabase } from "./lib/supabase";
import type { Session } from "@supabase/supabase-js";

import {
  Truck,
  LogOut,
  Package,
  Users,
  ClipboardList,
  Loader2
} from "lucide-react";

type Profile = {
  id: string;
  email: string;
  role: "seller" | "driver";
  is_active: boolean;
};

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // دریافت پروفایل کاربر از دیتابیس
  async function loadProfile(userId: string, userEmail: string) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, role, is_active")
      .eq("id", userId)
      .single();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new Error("پروفایل کاربر پیدا نشد.");
    }

    if (data.is_active !== true) {
      throw new Error("حساب کاربری غیرفعال است.");
    }

    if (data.role !== "seller" && data.role !== "driver") {
      throw new Error("نقش کاربر معتبر نیست.");
    }

    const userProfile: Profile = {
      id: data.id,
      email: userEmail,
      role: data.role,
      is_active: data.is_active
    };

    setProfile(userProfile);

    return userProfile;
  }

  // بررسی نشست قبلی هنگام باز شدن سایت
  useEffect(() => {
    let mounted = true;

    async function initialize() {
      try {
        const { data, error } = await supabase.auth.getSession();

        if (error) {
          throw error;
        }

        if (!mounted) return;

        setSession(data.session);

        if (data.session) {
          try {
            await loadProfile(
              data.session.user.id,
              data.session.user.email ?? ""
            );
          } catch (profileError) {
            console.error("Profile loading error:", profileError);

            if (mounted) {
              setProfile(null);
              setError("حساب کاربری فعال نیست یا اطلاعات پروفایل معتبر نیست.");
            }

            await supabase.auth.signOut();
          }
        }
      } catch (initializationError) {
        console.error("Initialization error:", initializationError);

        if (mounted) {
          setError("ارتباط با سامانه ناموفق بود. دوباره تلاش کنید.");
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    initialize();

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!mounted) return;

      setSession(newSession);

      if (!newSession) {
        setProfile(null);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  // ورود کاربر
  async function handleLogin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    setLoading(true);
    setError("");
    setProfile(null);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password
      });

      if (error) {
        throw error;
      }

      if (!data.user || !data.session) {
        throw new Error("اطلاعات ورود دریافت نشد.");
      }

      setSession(data.session);

      await loadProfile(
        data.user.id,
        data.user.email ?? ""
      );

      setPassword("");
    } catch (loginError) {
      console.error("Login error:", loginError);

      await supabase.auth.signOut();

      setSession(null);
      setProfile(null);

      setError(
        loginError instanceof Error
          ? loginError.message
          : "ورود به سامانه ناموفق بود."
      );
    } finally {
      setLoading(false);
    }
  }

  // خروج کاربر
  async function handleLogout() {
    setLoading(true);
    setError("");

    try {
      const { error } = await supabase.auth.signOut();

      if (error) {
        throw error;
      }

      setSession(null);
      setProfile(null);
      setPassword("");
    } catch (logoutError) {
      console.error("Logout error:", logoutError);
      setError("خروج از حساب ناموفق بود.");
    } finally {
      setLoading(false);
    }
  }

  // صفحه بارگذاری
  if (loading) {
    return (
      <div className="loading-screen">
        <Loader2 className="spin" size={36} />
        <p>در حال بارگذاری MITRA RUN...</p>
      </div>
    );
  }

  // صفحه ورود
  if (!session || !profile) {
    return (
      <main className="login-page">
        <form className="login-card" onSubmit={handleLogin}>
          <div className="brand-icon">
            <Truck size={34} />
          </div>

          <h1>MITRA RUN</h1>

          <p className="subtitle">
            سامانه مدیریت ارسال تشک میترا
          </p>

          <label htmlFor="login-email">ایمیل</label>

          <input
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ایمیل حساب کاربری"
            autoComplete="username"
            required
          />

          <label htmlFor="login-password">رمز عبور</label>

          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="رمز عبور"
            autoComplete="current-password"
            required
          />

          {error && (
            <div className="error">
              {error}
            </div>
          )}

          <button
            className="primary-button"
            type="submit"
            disabled={loading}
          >
            {loading ? "در حال ورود..." : "ورود به سامانه"}
          </button>

          <span className="version">
            MITRA RUN • VERSION 1.0
          </span>
        </form>
      </main>
    );
  }

  // پنل اصلی
  return (
    <main className="dashboard">
      <header className="topbar">
        <div className="brand">
          <Truck size={26} />

          <div>
            <strong>MITRA RUN</strong>
            <small>مدیریت ارسال میترا</small>
          </div>
        </div>

        <button
          className="logout-button"
          onClick={handleLogout}
          type="button"
        >
          <LogOut size={18} />
          خروج
        </button>
      </header>

      <section className="welcome">
        <span>خوش آمدید 👋</span>

        <h2>
          {profile.role === "seller"
            ? "پنل فروشنده"
            : "پنل راننده"}
        </h2>

        <p>{profile.email}</p>
      </section>

      {profile.role === "seller" ? (
        <section className="menu-grid">
          <DashboardCard
            icon={<Package />}
            title="ثبت سفارش"
          />

          <DashboardCard
            icon={<ClipboardList />}
            title="مدیریت سفارش‌ها"
          />

          <DashboardCard
            icon={<Users />}
            title="مدیریت رانندگان"
          />
        </section>
      ) : (
        <section className="menu-grid">
          <DashboardCard
            icon={<Truck />}
            title="مأموریت‌های من"
          />

          <DashboardCard
            icon={<Package />}
            title="سفارش‌های تحویلی"
          />

          <DashboardCard
            icon={<ClipboardList />}
            title="گزارش عملکرد"
          />
        </section>
      )}

      <footer>
        MITRA RUN © 2026
      </footer>
    </main>
  );
}

// کارت‌های داشبورد
function DashboardCard({
  icon,
  title
}: {
  icon: ReactNode;
  title: string;
}) {
  return (
    <button
      className="dashboard-card"
      type="button"
    >
      <span>{icon}</span>
      <strong>{title}</strong>
    </button>
  );
}
