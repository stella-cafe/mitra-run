import { useEffect, useState } from "react";
import type { FormEvent } from "react";
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
  
async function loadProfile(userId: string, userEmail: string) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id,role,is_active")
    .eq("id", userId)
    .single();

  if (error) throw error;

  if (!data || !data.is_active) {
    throw new Error("حساب کاربری غیرفعال است.");
  }

  if (data.role !== "seller" && data.role !== "driver") {
    throw new Error("نقش کاربر معتبر نیست.");
  }

  setProfile({
    id: data.id,
    email: userEmail,
    role: data.role,
    is_active: data.is_active
  });
}


    setProfile(data as Profile);
  }

  useEffect(() => {
    let mounted = true;

    async function initialize() {
      const { data } = await supabase.auth.getSession();

      if (mounted) {
        setSession(data.session);

        if (data.session) {
          try {
            await loadProfile(
  data.session.user.id,
  data.session.user.email ?? ""
);
          } catch {
            await supabase.auth.signOut();
            setError("دریافت اطلاعات حساب کاربری ناموفق بود.");
          }
        }

        setLoading(false);
      }
    }

    initialize();

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession);
        if (!newSession) setProfile(null);
      }
    );

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      setError("ایمیل یا رمز عبور صحیح نیست.");
      setLoading(false);
      return;
    }

    try {
      if (data.user) {
  await loadProfile(data.user.id, data.user.email ?? "");
}
    } catch {
      await supabase.auth.signOut();
      setError("حساب کاربری فعال نیست یا نقش آن مشخص نشده است.");
    }

    setLoading(false);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setProfile(null);
    setSession(null);
  }

  if (loading) {
    return (
      <div className="loading-screen">
        <Loader2 className="spin" size={36} />
        <p>در حال بارگذاری MITRA RUN...</p>
      </div>
    );
  }

  if (!session || !profile) {
    return (
      <main className="login-page">
        <form className="login-card" onSubmit={handleLogin}>
          <div className="brand-icon">
            <Truck size={34} />
          </div>

          <h1>MITRA RUN</h1>
          <p className="subtitle">سامانه مدیریت ارسال تشک میترا</p>

          <label>ایمیل</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ایمیل حساب کاربری"
            required
          />

          <label>رمز عبور</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="رمز عبور"
            required
          />

          {error && <div className="error">{error}</div>}

          <button className="primary-button" disabled={loading}>
            ورود به سامانه
          </button>

          <span className="version">MITRA RUN • VERSION 1.0</span>
        </form>
      </main>
    );
  }

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

        <button className="logout-button" onClick={handleLogout}>
          <LogOut size={18} />
          خروج
        </button>
      </header>

      <section className="welcome">
        <span>خوش آمدید 👋</span>
        <h2>{profile.role === "seller" ? "پنل فروشنده" : "پنل راننده"}</h2>
        <p>{profile.email}</p>
      </section>

      {profile.role === "seller" ? (
        <section className="menu-grid">
          <DashboardCard icon={<Package />} title="ثبت سفارش" />
          <DashboardCard icon={<ClipboardList />} title="مدیریت سفارش‌ها" />
          <DashboardCard icon={<Users />} title="مدیریت رانندگان" />
        </section>
      ) : (
        <section className="menu-grid">
          <DashboardCard icon={<Truck />} title="مأموریت‌های من" />
          <DashboardCard icon={<Package />} title="سفارش‌های تحویلی" />
          <DashboardCard icon={<ClipboardList />} title="گزارش عملکرد" />
        </section>
      )}

      <footer>MITRA RUN © 2026</footer>
    </main>
  );
}

function DashboardCard({
  icon,
  title
}: {
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <button className="dashboard-card" type="button">
      <span>{icon}</span>
      <strong>{title}</strong>
    </button>
  );
}
