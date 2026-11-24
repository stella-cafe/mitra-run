import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
(window as any).L = L;
import type { FormEvent, ReactNode } from "react";
import { supabase } from "./lib/supabase";
import type { Session } from "@supabase/supabase-js";
import {
  Truck, LogOut, Package, Users, ClipboardList, Loader2, Plus,
  RefreshCw, CheckCircle2, Clock3, MapPin, Wallet, FileCheck,
  ChevronLeft, X, Warehouse, AlertCircle, Eye, EyeOff, Phone
} from "lucide-react";

type Role = "seller" | "driver";
type Profile = { id: string; full_name: string; phone: string | null; role: Role; is_active: boolean };
type Customer = { id: string; full_name: string; address: string; notes?: string | null; latitude?: number | null; longitude?: number | null; phone?: string | null; phone2?: string | null; created_at?:string; is_archived?:boolean };
type Driver = { id: string; full_name: string; phone: string | null };
type Order = {
  id: string; order_number: number; customer_id: string; status: string;
  freight_toman: number; driver_freight_toman?: number | null; customer_cash_balance_toman: number; checks_total_toman: number;
  checks_count: number; seller_notes: string | null; created_at: string;
};
type Mission = {
  id: string; order_id: string; driver_id: string; status: string; created_at:string; failure_reason?: string | null;
  order?: Order | null; customer?: Customer | null;
};
type MissionItem = {
  id: string; mission_id: string; order_item_id: string; ordered_quantity: number; loaded_quantity: number | null;
  delivered_quantity: number | null; discrepancy_note: string | null;
  item?: { mattress_name: string; brand: string | null; size: string | null; weight: string } | null;
};
type Check = { id: string; order_id: string; total_amount_toman: number; check_count: number; status: string; seller_review_note: string | null; driver_confirmed_at?:string|null };
type Ledger = { id: string; driver_id?: string; order_id?: string | null; mission_id?: string | null; extra_job_id?: string | null; warehouse_visit_id?: string | null; entry_type: string; amount_toman: number; description: string | null; created_at: string };
type ExtraJob = {id:string;driver_id:string;job_type:string;title:string;address:string|null;amount_toman:number;notes:string|null;status:string;created_at:string;completed_at:string|null;review_note:string|null};
type DriverLocation = {driver_id:string;latitude:number;longitude:number;updated_at:string;driver?:{full_name:string;phone:string|null}};
type CashCollection = { id:string; order_id:string; amount_toman:number; status:string; created_at:string };
type CustomerCheck = {id:string;order_id:string;total_amount_toman:number;check_count:number;status:string;driver_confirmed_by?:string|null;driver_confirmed_at?:string|null};

function errorMessage(e: unknown, fallback = "عملیات ناموفق بود."): string {
  if (e && typeof e === "object") { const x = e as { message?: unknown; details?: unknown; hint?: unknown }; const parts = [x.message,x.details,x.hint].filter(v => typeof v === "string" && v.trim()) as string[]; if(parts.length)return parts.join(" — "); }
  return e instanceof Error ? e.message : fallback;
}
const distanceKm = (a:{latitude:number;longitude:number},b:{latitude:number;longitude:number}) => {
  const rad=(v:number)=>v*Math.PI/180;
  const dLat=rad(b.latitude-a.latitude),dLon=rad(b.longitude-a.longitude);
  const h=Math.sin(dLat/2)**2+Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(dLon/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
};
const money = (v?: number | null) => `${Number(v || 0).toLocaleString("fa-IR")} تومان`;
const normalizeDigits = (value:string) => value.replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
const normalizePhone = (value:string) => normalizeDigits(value).replace(/[\s\-()]/g,"").replace(/^\+98/,"0").replace(/^0098/,"0");
const validIranPhone = (value:string) => /^09\d{9}$/.test(normalizePhone(value));
const dateText = (v?: string) => v ? new Date(v).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short", timeZone:"Asia/Tehran", calendar:"persian" }) : "—";
const tehranDayKey=(v:string|Date)=>{const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tehran",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(v instanceof Date?v:new Date(v));const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return p.year+"-"+p.month+"-"+p.day;};
const isTodayTehran=(v?:string)=>!!v&&tehranDayKey(v)===tehranDayKey(new Date());
const tehranInputValue=()=>{const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tehran",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date());const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return p.year+"-"+p.month+"-"+p.day+"T"+p.hour+":"+p.minute;};
const tehranInputToIso=(v:string)=>new Date(v+":00+03:30").toISOString();
const statusFa: Record<string, string> = {
  registered: "ثبت‌شده", assigned: "ارجاع‌شده", accepted: "پذیرفته‌شده", loading: "در حال بارگیری",
  on_the_way: "در مسیر", delivered: "تحویل‌شده", partially_delivered: "تحویل ناقص",
  failed: "ناموفق", cancelled: "لغوشده", awaiting_driver: "در انتظار تأیید راننده",
  awaiting_seller: "در انتظار بررسی فروشنده", approved: "تأییدشده", rejected: "ردشده"
};
const weightFa: Record<string, string> = { light: "سبک", medium: "متوسط", heavy: "سنگین" };

// Read the complete ledger in pages so balances are never calculated from an arbitrary recent-row limit.
async function fetchAllLedger(driverId?: string): Promise<Ledger[]> {
  const all: Ledger[] = [];
  for (let from = 0; ; from += 1000) {
    const query = supabase.from("driver_ledger")
      .select("id,driver_id,order_id,mission_id,extra_job_id,warehouse_visit_id,entry_type,amount_toman,description,created_at")
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + 999);
    const result = driverId ? await query.eq("driver_id", driverId) : await query;
    if (result.error) throw result.error;
    const page = (result.data || []) as Ledger[];
    all.push(...page);
    if (page.length < 1000) break;
  }
  return all;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [email, setEmail] = useState(() => {
    try { return localStorage.getItem("mitra_run_email") || ""; }
    catch { return ""; }
  });
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    try {
      if (email.trim()) localStorage.setItem("mitra_run_email", email.trim());
      else localStorage.removeItem("mitra_run_email");
    } catch (e) { console.warn("Could not persist login email", e); }
  }, [email]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState("home");

  const loadProfile = useCallback(async (userId: string) => {
    const { data, error } = await supabase.from("profiles")
      .select("id,full_name,phone,role,is_active").eq("id", userId).single();
    if (error) throw error;
    if (!data || !data.is_active || !["seller", "driver"].includes(data.role))
      throw new Error("حساب کاربری فعال نیست یا نقش آن معتبر نیست.");
    const p = data as Profile;
    setProfile(p);
    return p;
  }, []);

  const refreshAuth = useCallback(async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    setSession(data.session);
    if (data.session) await loadProfile(data.session.user.id);
    else setProfile(null);
  }, [loadProfile]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { await refreshAuth(); }
      catch (e) { console.error(e); if (alive) setError(e instanceof Error ? e.message : "خطا در دریافت اطلاعات حساب"); }
      finally { if (alive) setLoading(false); }
    })();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      if (!alive) return;
      setSession(s);
      if (!s) setProfile(null);
      // Profile is loaded by the initial session flow or after login.
    });
    return () => { alive = false; subscription.unsubscribe(); };
  }, [refreshAuth]);

  async function login(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      if (!data.user) throw new Error("اطلاعات ورود دریافت نشد.");
      await loadProfile(data.user.id); setSession(data.session); setPassword("");
    } catch (e) {
      await supabase.auth.signOut();
      setSession(null); setProfile(null);
      setError(e instanceof Error ? e.message : "ورود ناموفق بود.");
    } finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true);
    const { error } = await supabase.auth.signOut();
    if (error) { setError(error.message); setBusy(false); return; }
    setSession(null); setProfile(null); setTab("home"); setBusy(false);
  }

  if (loading) return <div className="loading-screen"><Loader2 className="spin" size={36}/><p>در حال آماده‌سازی مسیرها…</p><strong>هر مسیر، یک قدم به مقصد</strong><small>Every route brings us closer.</small></div>;
  if (!session || !profile) return <main className="login-page"><form className="login-card" onSubmit={login} autoComplete="on">
    <div className="brand-icon"><Truck size={34}/></div><h1>GO</h1>
    <p className="subtitle">سامانه هوشمند مدیریت مسیرها و ارسال</p>
    <label>ایمیل</label><input type="email" name="username" value={email} onChange={e=>setEmail(e.target.value)} placeholder="ایمیل حساب کاربری" autoComplete="username" required/>
    <label>رمز عبور</label><div style={{display:"flex",gap:8,alignItems:"center"}}><input style={{flex:1}} type={showPassword?"text":"password"} name="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="رمز عبور" autoComplete="current-password" required/><button type="button" className="icon-button" aria-label={showPassword?"پنهان کردن رمز عبور":"نمایش رمز عبور"} onClick={()=>setShowPassword(v=>!v)}>{showPassword?<EyeOff size={18}/>:<Eye size={18}/>}</button></div>
    {error && <div className="error">{error}</div>}
    <button className="primary-button" disabled={busy}>{busy ? "در حال ورود..." : "ورود به سامانه"}</button>
    <span className="version">ایمیل به‌خاطر سپرده می‌شود؛ برای ذخیره امن رمز، پیشنهاد مرورگر را تأیید کنید.</span>
  </form></main>;

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark"><Truck size={23}/></span><div><strong>GO</strong><small>مدیریت هوشمند مسیرها</small></div></div>
      <div className="user-actions"><span className="user-name">{profile.full_name || session.user.email}</span><button className="icon-button" onClick={logout} title="خروج"><LogOut size={18}/></button></div>
    </header>
    <div className="page-heading"><div><span className="eyebrow">خوش آمدید</span><h1>{profile.role === "seller" ? "پنل فروشنده" : "پنل راننده"}</h1><p>{profile.role === "seller" ? "مدیریت سفارش‌ها، رانندگان و امور مالی" : "مأموریت‌ها و عملیات روزانه شما"}</p></div>
      <span className="role-pill">{profile.role === "seller" ? "فروشنده" : "راننده"}</span></div>
    {error && <div className="alert error-alert"><AlertCircle size={17}/>{error}<button onClick={()=>setError("")}><X size={15}/></button></div>}
    {notice && <div className="alert success-alert"><CheckCircle2 size={17}/>{notice}<button onClick={()=>setNotice("")}><X size={15}/></button></div>}
    {profile.role === "seller" ? <SellerPanel profile={profile} tab={tab} setTab={setTab} setError={setError} setNotice={setNotice}/> :
      <DriverPanel profile={profile} tab={tab} setTab={setTab} setError={setError} setNotice={setNotice}/>}
    <footer>GO © 2026</footer>
  </main>;
}

function Nav({tab,setTab,items}:{tab:string;setTab:(v:string)=>void;items:{id:string;label:string;icon:ReactNode}[]}) {
  return <nav className="nav-tabs">{items.map(i=><button key={i.id} className={tab===i.id?"active":""} onClick={()=>setTab(i.id)}>{i.icon}<span>{i.label}</span></button>)}</nav>;
}
function SectionTitle({title,sub,action}:{title:string;sub?:string;action?:ReactNode}) {
  return <div className="section-title"><div><h2>{title}</h2>{sub&&<p>{sub}</p>}</div>{action}</div>;
}
function Empty({text}:{text:string}) { return <div className="empty-state"><Package size={30}/><p>{text}</p><small>هر مسیر، یک قدم به مقصد · Every route brings us closer.</small></div>; }

function SellerPanel({profile,tab,setTab,setError,setNotice}:{profile:Profile;tab:string;setTab:(v:string)=>void;setError:(v:string)=>void;setNotice:(v:string)=>void}) {
  const [orders,setOrders] = useState<Order[]>([]);
  const [drivers,setDrivers] = useState<Driver[]>([]);
  const [customers,setCustomers] = useState<Customer[]>([]);
  const [archivedCustomers,setArchivedCustomers] = useState<Customer[]>([]);
  const [extraJobs,setExtraJobs] = useState<ExtraJob[]>([]);
  const [driverLocations,setDriverLocations] = useState<DriverLocation[]>([]);
  const [showRoundTrip,setShowRoundTrip] = useState(false);
  const [checks,setChecks] = useState<Check[]>([]);
  const [ledger,setLedger] = useState<Ledger[]>([]);
  const [busy,setBusy] = useState(false);
  const [showOrder,setShowOrder] = useState(false);
  const [reviewing,setReviewing] = useState<Check|null>(null);
  const [settling,setSettling] = useState<Driver|null>(null);
  
  const [editingOrder,setEditingOrder] = useState<Order|null>(null);
  const [editingCustomer,setEditingCustomer] = useState<Customer|null>(null);


  const load = useCallback(async()=>{
    setBusy(true); setError("");
    try {
      const [o,d,c,ch,extraJobsResult,driverLocationsResult,missionResult] = await Promise.all([
        supabase.from("orders").select("*").is("deleted_at",null).order("created_at",{ascending:false}).limit(100),
        supabase.from("profiles").select("id,full_name,phone").eq("role","driver").eq("is_active",true),
        supabase.from("customers").select("id,full_name,address,notes,latitude,longitude,created_at,is_archived").order("full_name"),
        supabase.from("customer_checks").select("*").order("created_at",{ascending:false}).limit(100),
        supabase.from("driver_extra_jobs").select("*").is("deleted_at",null).order("created_at",{ascending:false}).limit(100),
        supabase.from("driver_locations").select("driver_id,latitude,longitude,updated_at"),
        supabase.from("missions").select("id,order_id,status,created_at,driver_id").order("created_at",{ascending:false}).limit(200)
      ]);
      for (const r of [o,d,c,ch,extraJobsResult,driverLocationsResult,missionResult]) if (r.error) throw r.error;
      const allLedger = await fetchAllLedger();
      const ledgerOrderIds=[...new Set(allLedger.map(x=>x.order_id).filter(Boolean) as string[])];
      const ledgerExtraIds=[...new Set(allLedger.map(x=>x.extra_job_id).filter(Boolean) as string[])];
      const [ledgerOrdersResult,ledgerExtrasResult]=await Promise.all([
        ledgerOrderIds.length?supabase.from("orders").select("id,customer_id").in("id",ledgerOrderIds):Promise.resolve({data:[],error:null}),
        ledgerExtraIds.length?supabase.from("driver_extra_jobs").select("id,title,address").in("id",ledgerExtraIds):Promise.resolve({data:[],error:null})
      ]);
      if(ledgerOrdersResult.error)throw ledgerOrdersResult.error;if(ledgerExtrasResult.error)throw ledgerExtrasResult.error;
      const missionStatusByOrder=new Map<string,string>();
      for(const m of missionResult.data||[])missionStatusByOrder.set(m.order_id,m.status);
      setOrders(((o.data||[]) as Order[]).map(order=>({...order,status:missionStatusByOrder.get(order.id)||order.status}))); setDrivers((d.data||[]) as Driver[]);
      setExtraJobs((extraJobsResult.data||[]) as ExtraJob[]); setDriverLocations((driverLocationsResult.data||[]) as DriverLocation[]);
      const customerRows=(c.data||[]) as Customer[];
      if(customerRows.length){
        const phones=await supabase.from("customer_phones").select("customer_id,phone,is_primary").in("customer_id",customerRows.map(x=>x.id)).order("is_primary",{ascending:false});
        if(phones.error)throw phones.error;
        const phoneMap=new Map<string,string[]>();
        for(const p of phones.data||[]){const list=phoneMap.get(p.customer_id)||[];if(!list.includes(p.phone)&&list.length<2)list.push(p.phone);phoneMap.set(p.customer_id,list);}
        const enriched=customerRows.map(x=>({...x,phone:phoneMap.get(x.id)?.[0]||null,phone2:phoneMap.get(x.id)?.[1]||null}));
        setCustomers(enriched.filter(x=>!x.is_archived));
        setArchivedCustomers(enriched.filter(x=>x.is_archived||!isTodayTehran((x as any).created_at)));
      }else {setCustomers([]);setArchivedCustomers([]);}
      setChecks(((ch.data||[]) as Check[]).filter(x=>(o.data||[]).some((order:any)=>order.id===x.order_id)));
      const orderCustomer=new Map((ledgerOrdersResult.data||[]).map((order:any)=>[order.id,order.customer_id]));
      const customerById=new Map(customerRows.map(x=>[x.id,x]));
      const extraById=new Map((ledgerExtrasResult.data||[]).map((x:any)=>[x.id,x]));
      const ledgerWithContext=allLedger.map(entry=>{
        if((entry.description||"").includes("مشتری:")||(entry.description||"").includes("مقصد:"))return entry;
        if(entry.order_id){const customer=customerById.get(orderCustomer.get(entry.order_id)||"");if(customer)return {...entry,description:[entry.description||"کرایه سفارش","مشتری: "+customer.full_name,"آدرس: "+customer.address].join(" | ")};}
        if(entry.extra_job_id){const job=extraById.get(entry.extra_job_id);if(job)return {...entry,description:[entry.description||"کرایه مسیر","مقصد: "+job.title,"آدرس: "+(job.address||"ثبت نشده")].join(" | ")};}
        return entry;
      });
      setLedger(ledgerWithContext);
    } catch(e) { setError(e instanceof Error?e.message:"بارگذاری اطلاعات ناموفق بود."); }
    finally { setBusy(false); }
  },[setError]);
  useEffect(()=>{load();},[load]);
  useEffect(()=>{const timer=window.setInterval(async()=>{const [r,m]=await Promise.all([supabase.from("driver_locations").select("driver_id,latitude,longitude,updated_at"),supabase.from("missions").select("order_id,status").order("created_at",{ascending:false}).limit(200)]);if(!r.error)setDriverLocations((r.data||[]) as DriverLocation[]);if(!m.error){const statusMap=new Map<string,string>();for(const x of m.data||[])if(!statusMap.has(x.order_id))statusMap.set(x.order_id,x.status);setOrders(prev=>prev.map(o=>({...o,status:statusMap.get(o.id)||o.status})));}},15000);return()=>window.clearInterval(timer);},[]);


  async function deleteOrder(order:Order){
    try{
      const {error}=await supabase.rpc("go_seller_delete_order",{p_order_id:order.id});
      if(error)throw error;
      setNotice("سفارش و کرایه‌ها و سوابق وابسته آن حذف شدند.");await load();
    }catch(e){setError(errorMessage(e,"حذف سفارش ناموفق بود."));}
  }
  async function deleteExtraJob(job:ExtraJob){
    if(!window.confirm("مسیر «"+job.title+"» و کرایه وابسته آن از حساب راننده حذف شود؟"))return;
    try{const {error}=await supabase.rpc("go_delete_extra_job",{p_job_id:job.id});if(error)throw error;setNotice("مسیر و کرایه وابسته آن حذف شدند.");await load();}
    catch(e){setError(errorMessage(e,"حذف مسیر ناموفق بود."));}
  }

  async function archiveCustomer(customer:Customer){
    if(!window.confirm("مشتری «"+customer.full_name+"» از فهرست فعال حذف شود؟ سوابق سفارش‌ها حفظ می‌شوند."))return;
    try{const r=await supabase.from("customers").update({is_archived:true}).eq("id",customer.id);if(r.error)throw r.error;setNotice("مشتری از فهرست فعال بایگانی شد.");await load();}
    catch(e){setError(errorMessage(e,"حذف مشتری ناموفق بود."));}
  }

  async function review(check:Check,approved:boolean,note:string) {
    try {const {error}=await supabase.rpc("seller_review_check",{p_check_id:check.id,p_approved:approved,p_note:note||null});if(error)throw error;
      setNotice(approved?"چک تأیید شد.":"چک رد شد.");setReviewing(null);await load();
    }catch(e){setError(errorMessage(e,"ثبت بررسی چک ناموفق بود."));}
  }

  async function createRoundTrip(driverId:string,name:string,address:string,amount:number,note:string){try{const {error}=await supabase.rpc("go_seller_create_round_trip",{p_driver_id:driverId,p_customer_name:name.trim(),p_address:address.trim()||null,p_amount_toman:amount,p_notes:note.trim()||null});if(error)throw error;setShowRoundTrip(false);setNotice("مسیر رفت‌وبرگشت برای راننده تعریف شد؛ پس از انجام و تأیید فروشنده به حسابش اضافه می‌شود.");await load();}catch(e){setError(errorMessage(e,"تعریف رفت‌وبرگشت ناموفق بود."));}}
  async function reviewExtraJob(job:ExtraJob,approved:boolean){try{const {error}=await supabase.rpc("go_seller_review_extra_job",{p_job_id:job.id,p_approved:approved,p_note:null});if(error)throw error;setNotice(approved?"هزینه تأیید شد و به حساب راننده اضافه شد.":"درخواست هزینه رد شد.");await load();}catch(e){setError(errorMessage(e,"بررسی هزینه ناموفق بود."));}}
  async function settle(driver:Driver,amount:number,note:string){try{const {error}=await supabase.rpc("seller_settle_driver",{p_driver_id:driver.id,p_amount_toman:amount,p_note:note||null,p_receipt_path:null});if(error)throw error;setNotice("تسویه راننده با موفقیت ثبت شد.");setSettling(null);await load();}catch(e){setError(errorMessage(e,"ثبت تسویه ناموفق بود."));}}

  const nav=[{id:"home",label:"نمای کلی",icon:<ClipboardList size={17}/>},{id:"orders",label:"سفارش‌ها",icon:<Package size={17}/>},{id:"checks",label:"چک‌ها",icon:<FileCheck size={17}/>},{id:"finance",label:"مالی رانندگان",icon:<Wallet size={17}/>},{id:"customers",label:"مشتریان امروز",icon:<Users size={17}/>},{id:"archived-customers",label:"مشتریان بایگانی",icon:<Users size={17}/>},{id:"rates",label:"تعرفه مسیر",icon:<Wallet size={17}/>},{id:"extras",label:"هزینه‌های ویژه",icon:<Warehouse size={17}/>},{id:"locations",label:"موقعیت رانندگان",icon:<MapPin size={17}/>}];
  const openOrders=orders.filter(o=>!["delivered","partially_delivered","failed","cancelled"].includes(o.status));
  return <>
    <Nav tab={tab} setTab={setTab} items={nav}/>
    {tab==="home"&&<><div className="stats-grid"><Stat label="کل سفارش‌ها" value={orders.length}/><Stat label="در جریان" value={openOrders.length}/><Stat label="رانندگان فعال" value={drivers.length}/><Stat label="چک‌های منتظر بررسی" value={checks.filter(c=>c.status==="awaiting_seller").length}/></div>
      <SectionTitle title="آخرین سفارش‌ها" action={<button className="small-button" disabled={busy} onClick={load}><RefreshCw size={15}/> بروزرسانی</button>}/>
      <OrderList orders={orders.slice(0,6)} onEdit={setEditingOrder} onDelete={deleteOrder}/></>}
    {tab==="orders"&&<><SectionTitle title="مدیریت سفارش‌ها" sub="ثبت سفارش؛ مأموریت به‌صورت خودکار برای راننده اصلی ارسال می‌شود." action={<button className="primary-small" onClick={()=>setShowOrder(true)}><Plus size={16}/> ثبت سفارش</button>}/><OrderList orders={orders} onEdit={setEditingOrder} onDelete={deleteOrder}/></>}
    {tab==="checks"&&<><SectionTitle title="مدیریت چک‌های مشتریان" sub="چک‌های تأییدشده توسط راننده را بررسی کنید"/><div className="stack">{checks.map(c=><div className="data-card" key={c.id}><div className="card-top"><strong>سفارش #{c.order_id.slice(0,8)}</strong><Status value={c.status}/></div><p>{c.check_count.toLocaleString("fa-IR")} فقره چک · {money(c.total_amount_toman)}</p>{c.status==="awaiting_seller"&&c.driver_confirmed_at&&<button className="primary-small" onClick={()=>setReviewing(c)}>بررسی و تأیید چک</button>}{c.status==="awaiting_seller"&&!c.driver_confirmed_at&&<small className="negative">در انتظار تأیید راننده</small>}{c.seller_review_note&&<small>یادداشت: {c.seller_review_note}</small>}</div>)}{!checks.length&&<Empty text="هنوز چکی ثبت نشده است."/>}</div></>}
    {tab==="finance"&&<><SectionTitle title="دفتر مالی رانندگان" sub="مانده هر راننده و ثبت تسویه"/><div className="stack">{drivers.map(d=>{const rows=ledger.filter(x=>x.driver_id===d.id);const balance=rows.reduce((sum,x)=>sum+x.amount_toman,0);return <div className="data-card" key={d.id}><div className="card-top"><strong>{d.full_name}</strong><b className={balance<0?"negative":"positive"}>{money(balance)}</b></div><small>{d.phone||"شماره تماس ثبت نشده"}</small><button className="primary-small" disabled={balance<=0} onClick={()=>setSettling(d)}>ثبت تسویه</button></div>;})}{!drivers.length&&<Empty text="راننده فعالی وجود ندارد."/>}</div><SectionTitle title="آخرین تراکنش‌ها"/><div className="stack">{ledger.slice(0,40).map(x=><div className="data-card compact" key={x.id}><div className="card-top"><strong>{ledgerLabel(x.entry_type,x.description||"")}</strong><b className={x.amount_toman<0?"negative":"positive"}>{money(x.amount_toman)}</b></div><p>{x.description||"بدون توضیحات"}</p><small>{dateText(x.created_at)}</small></div>)}</div></>}
    {tab==="customers"&&<><SectionTitle title="مشتریان امروز" sub="فقط مشتریانی که امروز به فهرست اضافه شده‌اند"/><div className="stack">{customers.filter(c=>isTodayTehran(c.created_at)).map(c=>{const co=orders.filter(o=>o.customer_id===c.id);const cash=co.reduce((a,o)=>a+Number(o.customer_cash_balance_toman||0),0);const orderIds=co.map(o=>o.id);const checksTotal=checks.filter(ch=>orderIds.includes(ch.order_id)&&ch.status!=="approved").reduce((a,ch)=>a+Number(ch.total_amount_toman||0),0);return <div className="data-card compact" key={c.id}><strong>{c.full_name}</strong><p>{c.address}</p><small>{[c.phone,c.phone2].filter(Boolean).join(" · ")||"شماره تماس ثبت نشده"}</small><div className="card-grid"><span>مانده نقدی: {money(cash)}</span><span>چک‌ها: {money(checksTotal)}</span></div><div className="card-bottom"><button className="small-button" onClick={()=>setEditingCustomer(c)}>ویرایش</button><button className="danger-button" onClick={()=>archiveCustomer(c)}>بایگانی</button></div></div>;})}{!customers.some(c=>isTodayTehran(c.created_at))&&<Empty text="امروز مشتری جدیدی ثبت نشده است."/>}</div></>}
    {tab==="archived-customers"&&<><SectionTitle title="مشتریان بایگانی‌شده" sub="مشتریان روزهای قبل و مشتریانی که دستی بایگانی شده‌اند"/><div className="stack">{archivedCustomers.map(c=><div className="data-card compact" key={c.id}><strong>{c.full_name}</strong><p>{c.address}</p><small>{[c.phone,c.phone2].filter(Boolean).join(" · ")||"شماره تماس ثبت نشده"} · {dateText(c.created_at)}</small><div className="card-grid"><span>مانده نقدی: {money(orders.filter(o=>o.customer_id===c.id).reduce((a,o)=>a+Number(o.customer_cash_balance_toman||0),0))}</span><span>چک‌ها: {money(checks.filter(ch=>orders.some(o=>o.customer_id===c.id&&o.id===ch.order_id)&&ch.status!=="approved").reduce((a,ch)=>a+Number(ch.total_amount_toman||0),0))}</span></div><div className="card-bottom"><button className="small-button" onClick={()=>setEditingCustomer(c)}>ویرایش</button>{!c.is_archived&&<small>بایگانی خودکار بر اساس تاریخ ثبت</small>}</div></div>)}{!archivedCustomers.length&&<Empty text="مشتری بایگانی‌شده‌ای وجود ندارد."/>}</div></>}
    {tab==="extras"&&<><SectionTitle title="هزینه‌ها و مسیرهای ویژه" sub="رفت‌وبرگشت با هزینه فروشگاه و درخواست‌های هزینه راننده" action={<button className="primary-small" onClick={()=>setShowRoundTrip(true)}><Plus size={15}/> تعریف رفت‌وبرگشت</button>}/><div className="stack">{extraJobs.map(j=><div className="data-card" key={j.id}><div className="card-top"><strong>{j.title}</strong><Status value={j.status==="pending_approval"?"awaiting_seller":j.status}/></div><p>{drivers.find(d=>d.id===j.driver_id)?.full_name||"راننده"} · {j.address||"آدرس ثبت نشده"} · {money(j.amount_toman)}</p>{j.notes&&<small>{j.notes}</small>}{j.status==="pending_approval"&&<div className="card-bottom"><button className="danger-button" onClick={()=>reviewExtraJob(j,false)}>رد درخواست</button><button className="primary-small" onClick={()=>reviewExtraJob(j,true)}>تأیید و واریز به حساب</button></div>}{j.review_note&&<small>{j.review_note}</small>}<div className="card-bottom"><button className="danger-button" onClick={()=>deleteExtraJob(j)}>حذف مسیر و کرایه</button></div></div>)}{!extraJobs.length&&<Empty text="هزینه ویژه‌ای ثبت نشده است."/>}</div></>}
    {tab==="locations"&&<><SectionTitle title="موقعیت رانندگان" sub="آخرین موقعیتی که هر راننده از پنل خود ثبت کرده است." action={<button className="small-button" disabled={busy} onClick={load}><RefreshCw size={15}/> بروزرسانی</button>}/><DriverLocationsMap locations={driverLocations} drivers={drivers}/><div className="stack">{driverLocations.map(l=><div className="data-card compact" key={l.driver_id}><div className="card-top"><b>{drivers.find(d=>d.id===l.driver_id)?.full_name||"راننده"}</b><small>{dateText(l.updated_at)}</small></div><small>{l.latitude.toFixed(6)}, {l.longitude.toFixed(6)}</small></div>)}{!driverLocations.length&&<Empty text="هنوز موقعیتی از رانندگان دریافت نشده است."/>}</div></>}
        {tab==="rates"&&<FreightRatePanel setError={setError} setNotice={setNotice}/>}
    {showRoundTrip&&<RoundTripModal drivers={drivers} onClose={()=>setShowRoundTrip(false)} onSubmit={createRoundTrip}/>}
    {showOrder&&<OrderModal customers={customers} drivers={drivers} onClose={()=>setShowOrder(false)} onDone={async()=>{setShowOrder(false);setNotice("سفارش با موفقیت ثبت شد.");await load();}} onError={setError}/>}
    {editingOrder&&<EditOrderModal order={editingOrder} customers={customers} onClose={()=>setEditingOrder(null)} onDone={async()=>{setEditingOrder(null);setNotice("اطلاعات سفارش اصلاح شد.");await load();}} onError={setError}/>}
    {editingCustomer&&<CustomerEditModal customer={editingCustomer} onClose={()=>setEditingCustomer(null)} onDone={async()=>{setEditingCustomer(null);setNotice("اطلاعات مشتری و شماره‌های تماس ذخیره شد.");await load();}} onError={setError}/>}
    {reviewing&&<ReviewModal check={reviewing} onClose={()=>setReviewing(null)} onSubmit={review}/>}
    {settling&&<SettlementModal driver={settling} onClose={()=>setSettling(null)} onSubmit={(amount,note)=>settle(settling,amount,note)}/> }
    {busy&&<div className="inline-loading"><Loader2 className="spin" size={16}/> در حال بروزرسانی… · هر مسیر، یک قدم به مقصد</div>}
  </>;
}

function FreightRatePanel({setError,setNotice}:{setError:(v:string)=>void;setNotice:(v:string)=>void}) {
  const [amount,setAmount]=useState("");const [effective,setEffective]=useState(tehranInputValue);const [rows,setRows]=useState<{id:string;amount_toman:number;effective_from:string}[]>([]);const [busy,setBusy]=useState(false);
  const load=useCallback(async()=>{const r=await supabase.from("driver_freight_rates").select("id,amount_toman,effective_from").order("effective_from",{ascending:false}).limit(50);if(r.error)throw r.error;setRows(r.data||[]);},[]);
  useEffect(()=>{load().catch(e=>setError(errorMessage(e,"دریافت تعرفه‌ها ناموفق بود.")));},[load,setError]);
  async function submit(e:FormEvent){e.preventDefault();const n=Number(normalizeDigits(amount));if(!Number.isFinite(n)||n<0){setError("مبلغ کرایه معتبر نیست.");return;}setBusy(true);try{const r=await supabase.from("driver_freight_rates").insert({amount_toman:n,effective_from:tehranInputToIso(effective)});if(r.error)throw r.error;setAmount("");setNotice("تعرفه جدید ذخیره شد و از تاریخ تعیین‌شده برای مسیرهای بعدی اعمال می‌شود.");await load();}catch(e){setError(errorMessage(e,"ثبت تعرفه ناموفق بود."));}finally{setBusy(false);}}
  return <><SectionTitle title="تعرفه کرایه راننده" sub="هر تعرفه از تاریخ و ساعت شروع، روی مأموریت‌هایی که از آن زمان به بعد ارجاع می‌شوند اعمال می‌شود."/><form className="data-card form-stack" onSubmit={submit}><Field label="مبلغ کرایه هر مسیر (تومان)" value={amount} set={setAmount} type="number" required/><label>تاریخ و ساعت شروع اعمال (تقویم شمسی)<JalaliDateTimeField value={effective} onChange={setEffective}/></label><button className="primary-button" disabled={busy}>{busy?"در حال ذخیره…":"ثبت تعرفه جدید"}</button></form><SectionTitle title="سوابق تعرفه‌ها"/><div className="stack">{rows.map(r=><div className="data-card compact" key={r.id}><div className="card-top"><b>{money(r.amount_toman)}</b><small>{dateText(r.effective_from)}</small></div></div>)}{!rows.length&&<Empty text="هنوز تعرفه‌ای ثبت نشده است."/>}</div></>;
}

function CustomerEditModal({customer,onClose,onDone,onError}:{customer:Customer;onClose:()=>void;onDone:()=>void;onError:(v:string)=>void}) {
  const [name,setName]=useState(customer.full_name);const [address,setAddress]=useState(customer.address);
  const [phone,setPhone]=useState(customer.phone||"");const [phone2,setPhone2]=useState(customer.phone2||"");
  const [latitude,setLatitude]=useState<number|null>(customer.latitude??null);const [longitude,setLongitude]=useState<number|null>(customer.longitude??null);const [busy,setBusy]=useState(false);
  async function save(e:FormEvent){e.preventDefault();if(!name.trim()||!address.trim()||!phone.trim()||!validIranPhone(phone)||(phone2.trim()&&!validIranPhone(phone2))){onError("نام، آدرس و شماره تماس معتبر الزامی است.");return;}setBusy(true);try{
    const u=await supabase.from("customers").update({full_name:name.trim(),address:address.trim(),latitude,longitude}).eq("id",customer.id);if(u.error)throw u.error;
    const q=await supabase.from("customer_phones").select("id").eq("customer_id",customer.id).order("is_primary",{ascending:false});if(q.error)throw q.error;
    const values=[normalizePhone(phone),normalizePhone(phone2)].filter(Boolean);
    for(let i=0;i<2;i++){const row=q.data?.[i],value=values[i];if(row&&value){const x=await supabase.from("customer_phones").update({phone:value,is_primary:i===0}).eq("id",row.id);if(x.error)throw x.error;}else if(row&&!value){const x=await supabase.from("customer_phones").delete().eq("id",row.id);if(x.error)throw x.error;}else if(!row&&value){const x=await supabase.from("customer_phones").insert({customer_id:customer.id,phone:value,is_primary:i===0});if(x.error)throw x.error;}}
    onDone();
  }catch(e){onError(errorMessage(e,"ویرایش مشتری ناموفق بود."));}finally{setBusy(false);}}
  return <Modal title="ویرایش مشتری" onClose={onClose}><form className="form-grid" onSubmit={save}><Field label="نام مشتری" value={name} set={setName} required/><Field label="شماره تماس اول" value={phone} set={setPhone} required/><Field label="شماره تماس دوم (اختیاری)" value={phone2} set={setPhone2}/><label className="full">آدرس تحویل<textarea rows={2} value={address} onChange={e=>setAddress(e.target.value)} required/></label><div className="full"><MapPicker latitude={latitude} longitude={longitude} onChange={(a,b)=>{setLatitude(a);setLongitude(b);}}/></div><div className="modal-actions full"><button type="button" className="secondary-button" onClick={onClose}>انصراف</button><button className="primary-button" disabled={busy}>{busy?"در حال ذخیره…":"ذخیره مشتری"}</button></div></form></Modal>;
}

function Stat({label,value}:{label:string;value:number}) {return <div className="stat-card"><span>{label}</span><strong>{value.toLocaleString("fa-IR")}</strong></div>;}
function Status({value}:{value:string}) {return <span className={`status status-${value}`}>{statusFa[value]||value}</span>;}
function OrderList({orders,onEdit,onDelete}:{orders:Order[];onEdit:(o:Order)=>void;onDelete:(o:Order)=>void}) {
  return <div className="stack">{orders.map(o=><div className="data-card" key={o.id}><div className="card-top"><strong>سفارش #{o.order_number.toLocaleString("fa-IR")}</strong><Status value={o.status}/></div>
    <div className="card-grid"><span>شناسه مشتری: {o.customer_id.slice(0,8)}</span><span>کرایه مشتری: {money(o.freight_toman)}</span><span>کرایه راننده: {money(o.driver_freight_toman)}</span><span>مانده نقدی: {money(o.customer_cash_balance_toman)}</span><span>چک: {money(o.checks_total_toman)}</span></div>
    {o.seller_notes&&<p>{o.seller_notes}</p>}<div className="card-bottom"><small>{dateText(o.created_at)}</small><><button className="small-button" onClick={()=>onEdit(o)}>ویرایش سفارش</button><button className="danger-button" onClick={()=>{if(window.confirm("سفارش #"+o.order_number.toLocaleString("fa-IR")+" و تمام سوابق مالی وابسته حذف شود؟ این عملیات قابل بازگشت نیست."))onDelete(o);}}>حذف سفارش</button></></div></div>)}
    {!orders.length&&<Empty text="سفارشی برای نمایش وجود ندارد."/>}</div>;
}

function OrderModal({customers,drivers,onClose,onDone,onError}:{customers:Customer[];drivers:Driver[];onClose:()=>void;onDone:()=>void;onError:(v:string)=>void}) {
  const [customerId,setCustomerId]=useState("");const [fullName,setFullName]=useState("");const [phone,setPhone]=useState("");const [phone2,setPhone2]=useState("");
  const [address,setAddress]=useState("");const [freight,setFreight]=useState("0");const [cash,setCash]=useState("0");
  const [checksTotal,setChecksTotal]=useState("0");const [checksCount,setChecksCount]=useState("0");const [notes,setNotes]=useState("");const [driverId,setDriverId]=useState(drivers.length===1?drivers[0].id:"");
  const [items,setItems]=useState<{name:string;quantity:string}[]>([{name:"",quantity:"1"}]);
  const [latitude,setLatitude]=useState<number|null>(null);const [longitude,setLongitude]=useState<number|null>(null);const [busy,setBusy]=useState(false);
  useEffect(()=>{if(drivers.length===1)setDriverId(drivers[0].id);else setDriverId("");},[drivers]);
  function chooseCustomer(id:string){setCustomerId(id);const c=customers.find(x=>x.id===id);if(c){setFullName(c.full_name);setPhone(c.phone||"");setPhone2(c.phone2||"");setAddress(c.address);setLatitude(c.latitude??null);setLongitude(c.longitude??null);}else{setFullName("");setPhone("");setPhone2("");setAddress("");setLatitude(null);setLongitude(null);}}
  function setItem(index:number,key:"name"|"quantity",value:string){setItems(rows=>rows.map((x,i)=>i===index?{...x,[key]:value}:x));}
  async function savePhones(customer:string){
    const values=[normalizePhone(phone),normalizePhone(phone2)].filter(Boolean);
    const existing=await supabase.from("customer_phones").select("id,phone,is_primary").eq("customer_id",customer).order("is_primary",{ascending:false});
    if(existing.error)throw existing.error;
    for(let i=0;i<2;i++){const row=existing.data?.[i],value=values[i];if(row&&value){const u=await supabase.from("customer_phones").update({phone:value,is_primary:i===0}).eq("id",row.id);if(u.error)throw u.error;}else if(row&&!value){const d=await supabase.from("customer_phones").delete().eq("id",row.id);if(d.error)throw d.error;}else if(!row&&value){const ins=await supabase.from("customer_phones").insert({customer_id:customer,phone:value,is_primary:i===0});if(ins.error)throw ins.error;}}
  }
  async function submit(e:FormEvent){
    e.preventDefault();
    if(!fullName.trim()||!phone.trim()||!address.trim()||!items.length||items.some(x=>!x.name.trim())){onError("نام مشتری، شماره تماس اول، آدرس و نام کالا الزامی است.");return;}
    if(!validIranPhone(phone)||(phone2.trim()&&!validIranPhone(phone2))){onError("شماره تماس را با فرمت ۰۹۱۲۳۴۵۶۷۸۹ وارد کنید.");return;}
    if(items.some(x=>!Number.isInteger(Number(normalizeDigits(x.quantity)))||Number(normalizeDigits(x.quantity))<1)){onError("تعداد هر کالا باید عدد صحیح و حداقل ۱ باشد.");return;}
    if([freight,cash,checksTotal,checksCount].some(v=>!Number.isFinite(Number(normalizeDigits(v)))||Number(normalizeDigits(v))<0)){onError("مبالغ و تعداد چک نمی‌توانند منفی یا نامعتبر باشند.");return;}
    if((Number(normalizeDigits(checksTotal))>0)!==(Number(normalizeDigits(checksCount))>0)){onError("برای چک، هم مبلغ و هم تعداد را وارد کنید.");return;}
    if(drivers.length!==1||!drivers[0]?.id){onError("برای ثبت سفارش باید دقیقاً یک راننده فعال در سامانه وجود داشته باشد.");return;}
    setBusy(true);
    try{
      if(customerId){const cu=await supabase.from("customers").update({full_name:fullName.trim(),address:address.trim(),latitude,longitude}).eq("id",customerId);if(cu.error)throw cu.error;await savePhones(customerId);}
      const startedAt=new Date(Date.now()-2000).toISOString();
      const {error}=await supabase.rpc("seller_create_order",{
        p_customer_id:customerId||null,p_full_name:fullName.trim(),p_address:address.trim(),p_phone:normalizePhone(phone),
        p_latitude:latitude,p_longitude:longitude,p_freight_toman:Number(normalizeDigits(freight||"0")),p_cash_balance_toman:Number(normalizeDigits(cash||"0")),
        p_checks_total_toman:Number(normalizeDigits(checksTotal||"0")),p_checks_count:Number(normalizeDigits(checksCount||"0")),p_seller_notes:notes.trim()||null,
        p_items:items.map(x=>({mattress_name:x.name.trim(),brand:null,size:null,quantity:Number(normalizeDigits(x.quantity)),weight:"medium",notes:null})),
        p_driver_id:drivers[0].id
      });
      if(error)throw error;
      if(customerId)await savePhones(customerId);
      else if(phone2.trim()){
        const {data:userData,error:userError}=await supabase.auth.getUser();if(userError)throw userError;
        const created=await supabase.from("orders").select("customer_id").eq("created_by",userData.user.id).gte("created_at",startedAt).order("created_at",{ascending:false}).limit(1).maybeSingle();
        if(created.error)throw created.error;if(!created.data?.customer_id)throw new Error("سفارش ثبت شد اما شماره دوم ذخیره نشد؛ از بخش مشتریان اصلاح کنید.");
        const ins=await supabase.from("customer_phones").insert({customer_id:created.data.customer_id,phone:normalizePhone(phone2),is_primary:false});if(ins.error)throw ins.error;
      }
      if(driverId){const {data:userData}=await supabase.auth.getUser();const created=await supabase.from("orders").select("id").eq("created_by",userData.user?.id||"").gte("created_at",startedAt).order("created_at",{ascending:false}).limit(1).maybeSingle();if(created.data?.id){const rate=await supabase.from("driver_freight_rates").select("amount_toman").lte("effective_from",new Date().toISOString()).order("effective_from",{ascending:false}).limit(1).maybeSingle();if(rate.data){const u=await supabase.from("orders").update({driver_freight_toman:rate.data.amount_toman}).eq("id",created.data.id);if(u.error)throw u.error;}}}
      onDone();
    }catch(e){onError(errorMessage(e,"ثبت سفارش انجام نشد."));}finally{setBusy(false);}
  }
  return <Modal title="ثبت سفارش جدید" onClose={onClose}><form className="form-grid" onSubmit={submit}>
    <label className="full">مشتری قبلی (اختیاری)<select value={customerId} onChange={e=>chooseCustomer(e.target.value)}><option value="">ثبت مشتری جدید</option>{customers.map(c=><option key={c.id} value={c.id}>{c.full_name} — {c.address}</option>)}</select></label>
    <Field label="نام مشتری" value={fullName} set={setFullName} required/><Field label="شماره تماس اول" value={phone} set={setPhone} required/><Field label="شماره تماس دوم (اختیاری)" value={phone2} set={setPhone2}/>
    <label className="full">آدرس تحویل<textarea value={address} onChange={e=>setAddress(e.target.value)} required rows={2}/></label><div className="full"><MapPicker latitude={latitude} longitude={longitude} onChange={(lat,lng)=>{setLatitude(lat);setLongitude(lng);}}/></div>
    <div className="full divider-label">کالاهای سفارش</div>
    {items.map((item,index)=><div className="full item-edit" key={index}><div className="card-top"><b>کالای {index+1}</b>{items.length>1&&<button type="button" className="danger-button" onClick={()=>setItems(rows=>rows.filter((_,i)=>i!==index))}>حذف کالا</button>}</div><div className="inline-fields"><Field label="کالا" value={item.name} set={v=>setItem(index,"name",v)} required/><Field label="تعداد" value={item.quantity} set={v=>setItem(index,"quantity",v)} type="number" required/></div></div>)}
    <button type="button" className="secondary-button full" onClick={()=>setItems(rows=>[...rows,{name:"",quantity:"1"}])}><Plus size={16}/> افزودن کالا</button>
    <Field label="کرایه مشتری (تومان)" value={freight} set={setFreight} type="number"/><Field label="مانده نقدی مشتری (تومان)" value={cash} set={setCash} type="number"/>
    <Field label="مبلغ چک‌ها (تومان)" value={checksTotal} set={setChecksTotal} type="number"/><Field label="تعداد چک" value={checksCount} set={setChecksCount} type="number"/>
    <div className="full detail-box">این سفارش پس از ثبت، به‌صورت خودکار برای راننده اصلی ({drivers.length===1?drivers[0].full_name:"راننده فعال"}) ارسال می‌شود.</div>
    <label className="full">توضیحات فروشنده<textarea value={notes} onChange={e=>setNotes(e.target.value)} rows={2}/></label>
    <div className="modal-actions full"><button type="button" className="secondary-button" onClick={onClose}>انصراف</button><button className="primary-button" disabled={busy}>{busy?"در حال ثبت…":"ثبت سفارش"}</button></div>
  </form></Modal>;
}

function EditOrderModal({order,customers,onClose,onDone,onError}:{order:Order;customers:Customer[];onClose:()=>void;onDone:()=>void;onError:(v:string)=>void}) {
  const customer=customers.find(c=>c.id===order.customer_id);
  const [name,setName]=useState(customer?.full_name||"");
  const [phone,setPhone]=useState(customer?.phone||"");const [phone2,setPhone2]=useState(customer?.phone2||"");
  const [address,setAddress]=useState(customer?.address||"");
  const [latitude,setLatitude]=useState<number|null>(customer?.latitude??null);const [longitude,setLongitude]=useState<number|null>(customer?.longitude??null);
  const [notes,setNotes]=useState(order.seller_notes||"");
  const [orderItems,setOrderItems]=useState<{id:string;name:string;quantity:string}[]>([]);
  const [busy,setBusy]=useState(false);
  useEffect(()=>{let alive=true;(async()=>{const q=await supabase.from("order_items").select("id,mattress_name,quantity").eq("order_id",order.id).order("created_at",{ascending:true});if(q.error){onError(errorMessage(q.error,"دریافت اقلام سفارش ناموفق بود."));return;}if(alive&&q.data?.length){setOrderItems(q.data.map(x=>({id:x.id,name:x.mattress_name,quantity:String(x.quantity)})));}})();return()=>{alive=false;};},[order.id]);
  async function save(e:FormEvent){e.preventDefault();if(!customer){onError("مشتری این سفارش پیدا نشد.");return;}if(!name.trim()||!phone.trim()||!address.trim()||!orderItems.length||orderItems.some(x=>!x.name.trim())){onError("نام مشتری، تلفن، آدرس و نام تشک الزامی است.");return;}if(!validIranPhone(phone)||(phone2.trim()&&!validIranPhone(phone2))){onError("شماره تماس را با فرمت ۰۹۱۲۳۴۵۶۷۸۹ وارد کنید.");return;}if(orderItems.some(x=>!Number.isInteger(Number(x.quantity))||Number(x.quantity)<1)){onError("تعداد هر قلم باید عدد صحیح و مثبت باشد.");return;}
    setBusy(true);try{
      const cu=await supabase.from("customers").update({full_name:name.trim(),address:address.trim(),latitude,longitude}).eq("id",customer.id);if(cu.error)throw cu.error;
      const q=await supabase.from("customer_phones").select("id").eq("customer_id",customer.id).order("is_primary",{ascending:false});if(q.error)throw q.error;
      const values=[normalizePhone(phone),normalizePhone(phone2)].filter(Boolean);
      for(let i=0;i<2;i++){const row=q.data?.[i],value=values[i];if(row&&value){const ph=await supabase.from("customer_phones").update({phone:value,is_primary:i===0}).eq("id",row.id);if(ph.error)throw ph.error;}else if(row&&!value){const ph=await supabase.from("customer_phones").delete().eq("id",row.id);if(ph.error)throw ph.error;}else if(!row&&value){const ph=await supabase.from("customer_phones").insert({customer_id:customer.id,phone:value,is_primary:i===0});if(ph.error)throw ph.error;}}
      const up=await supabase.from("orders").update({seller_notes:notes.trim()||null}).eq("id",order.id);if(up.error)throw up.error;
      for(const item of orderItems){const it=await supabase.from("order_items").update({mattress_name:item.name.trim(),quantity:Number(normalizeDigits(item.quantity))}).eq("id",item.id);if(it.error)throw it.error;}
      onDone();
    }catch(e){onError(errorMessage(e,"ویرایش سفارش ناموفق بود."));}finally{setBusy(false);}
  }
  return <Modal title={`ویرایش سفارش #${order.order_number}`} onClose={onClose}><form className="form-grid" onSubmit={save}>
    <Field label="نام مشتری" value={name} set={setName} required/><Field label="شماره تماس اول" value={phone} set={setPhone} required/><Field label="شماره تماس دوم (اختیاری)" value={phone2} set={setPhone2}/>
    <label className="full">آدرس کامل<textarea rows={2} value={address} onChange={e=>setAddress(e.target.value)} required/></label><div className="full"><MapPicker latitude={latitude} longitude={longitude} onChange={(a,b)=>{setLatitude(a);setLongitude(b);}}/></div>
    <div className="full divider-label">مشخصات اقلام سفارش</div>{orderItems.map((item,index)=><div className="full inline-fields" key={item.id}><Field label={"کالا "+(index+1)} value={item.name} set={v=>setOrderItems(rows=>rows.map(x=>x.id===item.id?{...x,name:v}:x))} required/><Field label="تعداد" value={item.quantity} set={v=>setOrderItems(rows=>rows.map(x=>x.id===item.id?{...x,quantity:v}:x))} type="number" required/></div>)}
    
    <label className="full">توضیحات فروشنده<textarea rows={2} value={notes} onChange={e=>setNotes(e.target.value)}/></label>
    <p className="muted full">برای حفظ یکپارچگی حساب‌ها، کرایه و مانده نقدی از این فرم قابل تغییر نیستند. سوابق مالی دست‌نخورده باقی می‌مانند.</p>
    <div className="modal-actions full"><button type="button" className="secondary-button" onClick={onClose}>انصراف</button><button className="primary-button" disabled={busy}>{busy?"در حال ذخیره…":"ذخیره تغییرات"}</button></div>
  </form></Modal>;
}


function MapPicker({latitude,longitude,onChange}:{latitude:number|null;longitude:number|null;onChange:(lat:number,lng:number)=>void}) {
  const element=useRef<HTMLDivElement|null>(null);const map=useRef<any>(null);const pin=useRef<any>(null);
  const latest=useRef({latitude,longitude,onChange});latest.current={latitude,longitude,onChange};
  const [mapError,setMapError]=useState("");const [query,setQuery]=useState("");const [searching,setSearching]=useState(false);const [results,setResults]=useState<{name:string;lat:number;lng:number}[]>([]);
  useEffect(()=>{
    let cancelled=false;
    const init=()=>{const L=(window as any).L;if(cancelled||!L||!element.current)return;
      if(L.Icon?.Default){delete L.Icon.Default.prototype._getIconUrl;L.Icon.Default.mergeOptions({iconRetinaUrl:"https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",iconUrl:"https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",shadowUrl:"https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png"});}
      if(map.current)map.current.remove();const cur=latest.current;const start:[number,number]=cur.latitude!==null&&cur.longitude!==null?[cur.latitude,cur.longitude]:[36.2972,59.6067];
      map.current=L.map(element.current,{scrollWheelZoom:true,zoomControl:true}).setView(start,cur.latitude!==null&&cur.longitude!==null?17:14);
      const hot=L.tileLayer("https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",{subdomains:["a","b","c"],maxZoom:19,attribution:"© OpenStreetMap contributors, HOT",crossOrigin:true}).addTo(map.current);let fallbackAdded=false;hot.on("tileerror",()=>{if(fallbackAdded||!map.current)return;fallbackAdded=true;L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{subdomains:["a","b","c"],maxZoom:19,attribution:"© OpenStreetMap contributors"}).addTo(map.current);});
      if(cur.latitude!==null&&cur.longitude!==null){pin.current=L.marker(start,{draggable:true}).addTo(map.current);pin.current.on("dragend",(ev:any)=>{const p=ev.target.getLatLng();latest.current.onChange(Number(p.lat.toFixed(7)),Number(p.lng.toFixed(7)));});}
      map.current.on("click",(ev:any)=>{const lat=Number(ev.latlng.lat.toFixed(7)),lng=Number(ev.latlng.lng.toFixed(7));if(pin.current)pin.current.setLatLng([lat,lng]);else{pin.current=L.marker([lat,lng],{draggable:true}).addTo(map.current);pin.current.on("dragend",(ev:any)=>{const p=ev.target.getLatLng();latest.current.onChange(Number(p.lat.toFixed(7)),Number(p.lng.toFixed(7)));});}latest.current.onChange(lat,lng);});
      setTimeout(()=>map.current&&map.current.invalidateSize(),120);
    };
    const w=window as any;if(w.L)init();else{
      if(!document.getElementById("mitra-leaflet-css")){const css=document.createElement("link");css.id="mitra-leaflet-css";css.rel="stylesheet";css.href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";document.head.appendChild(css);}
      let script=document.getElementById("mitra-leaflet-js") as HTMLScriptElement|null;
      if(!script){script=document.createElement("script");script.id="mitra-leaflet-js";script.src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";script.onload=init;script.onerror=()=>setMapError("نقشه بارگذاری نشد؛ اتصال اینترنت را بررسی کنید.");document.body.appendChild(script);}
      else if(w.L)init();else script.addEventListener("load",init,{once:true});
    }
    return()=>{cancelled=true;if(map.current){map.current.remove();map.current=null;pin.current=null;}};
  },[]);
  useEffect(()=>{if(map.current&&latitude!==null&&longitude!==null){const L=(window as any).L;if(pin.current)pin.current.setLatLng([latitude,longitude]);else{pin.current=L.marker([latitude,longitude],{draggable:true}).addTo(map.current);pin.current.on("dragend",(ev:any)=>{const p=ev.target.getLatLng();latest.current.onChange(Number(p.lat.toFixed(7)),Number(p.lng.toFixed(7)));});}map.current.setView([latitude,longitude],16);}},[latitude,longitude]);
  async function search(){
    const term=query.trim().replace(/[يى]/g,"ی").replace(/ك/g,"ک").replace(/[۰-۹]/g,d=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
    if(!term)return;
    setSearching(true);setMapError("");setResults([]);
    const normalize=(rows:any[],source:"photon"|"nominatim")=>rows.map((f:any)=>{
      const p=source==="photon"?f.properties||{}:f.address||{};
      const lat=source==="photon"?Number(f.geometry?.coordinates?.[1]):Number(f.lat);
      const lng=source==="photon"?Number(f.geometry?.coordinates?.[0]):Number(f.lon);
      const name=source==="photon"?[p.name,p.street,p.housenumber,p.district,p.city,p.state,p.country].filter(Boolean).join("، "):[f.name||f.display_name].filter(Boolean).join("، ");
      return {name,lat,lng};
    }).filter((x:any)=>Number.isFinite(x.lat)&&Number.isFinite(x.lng)&&x.lat>=24&&x.lat<=40&&x.lng>=44&&x.lng<=64);
    try{
      let list:{name:string;lat:number;lng:number}[]=[];
      const photonParams=new URLSearchParams({q:term,lang:"fa",limit:"10",lat:"36.2972",lon:"59.6067",zoom:"13",countrycode:"IR"});
      try{
        const photon=await fetch("https://photon.komoot.io/api/?"+photonParams.toString(),{headers:{Accept:"application/json"}});
        if(photon.ok){const data=await photon.json();list=normalize(data.features||[],"photon");}
      }catch{}
      if(!list.length){
        const nominatimParams=new URLSearchParams({q:term,format:"jsonv2",addressdetails:"1",limit:"8","accept-language":"fa",countrycodes:"ir",viewbox:"60.2,36.6,59.0,35.7"});
        const nominatim=await fetch("https://nominatim.openstreetmap.org/search?"+nominatimParams.toString(),{headers:{Accept:"application/json"}});
        if(!nominatim.ok)throw new Error("سرویس‌های جست‌وجوی نشانی پاسخ ندادند. چند لحظه بعد دوباره امتحان کنید.");
        list=normalize(await nominatim.json(),"nominatim");
      }
      setResults(list);
      if(!list.length)setMapError("نشانی پیدا نشد. نام خیابان را همراه نام شهر وارد کنید؛ مثلاً خیابان احمدآباد، مشهد.");
    }catch(e){setMapError(errorMessage(e,"جست‌وجوی نشانی ناموفق بود. می‌توانید مستقیماً روی نقشه نقطه بزنید."));}
    finally{setSearching(false);}
  }
  function choose(x:{name:string;lat:number;lng:number}){const L=(window as any).L;if(map.current&&L){if(pin.current)pin.current.setLatLng([x.lat,x.lng]);else{pin.current=L.marker([x.lat,x.lng],{draggable:true}).addTo(map.current);pin.current.on("dragend",(ev:any)=>{const p=ev.target.getLatLng();latest.current.onChange(Number(p.lat.toFixed(7)),Number(p.lng.toFixed(7)));});}map.current.setView([x.lat,x.lng],17);}latest.current.onChange(x.lat,x.lng);setQuery(x.name);setResults([]);}
  return <div className="map-picker"><b>انتخاب موقعیت مشتری</b><small>نام شهر، خیابان، کوچه یا محله را به فارسی جست‌وجو کنید؛ یا روی نقشه نقطه بزنید. جست‌وجو در محدوده ایران انجام می‌شود.</small><div className="map-search"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="نام شهر، محله، خیابان یا کوچه در ایران…" onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();search();}}}/><button type="button" className="primary-small" disabled={searching||!query.trim()} onClick={search}>{searching?"…":"جست‌وجو"}</button></div>{results.length>0&&<div className="map-results">{results.map((x,i)=><button type="button" key={i} onClick={()=>choose(x)}>{x.name||"موقعیت پیدا شده"}</button>)}</div>}<div ref={element} className="map-canvas"/>{mapError&&<small className="error">{mapError}</small>}<small>{latitude!==null&&longitude!==null?("مختصات: "+latitude.toFixed(6)+", "+longitude.toFixed(6)):"موقعیت هنوز انتخاب نشده است."}</small>{latitude!==null&&longitude!==null&&<a className="neshan-link" href={"https://nshn.ir/?lat="+latitude+"&lng="+longitude} target="_blank" rel="noreferrer">باز کردن موقعیت در نشان</a>}</div>;
}

function DriverLocationsMap({locations,drivers}:{locations:DriverLocation[];drivers:Driver[]}) {
  const element=useRef<HTMLDivElement|null>(null);const map=useRef<any>(null);const layer=useRef<any>(null);
  const latest=useRef({locations,drivers});latest.current={locations,drivers};
  useEffect(()=>{
    let cancelled=false;
    const init=()=>{const L=(window as any).L;if(cancelled||!L||!element.current)return;
      if(map.current)map.current.remove();
      const points=latest.current.locations;const center:[number,number]=points.length?[points[0].latitude,points[0].longitude]:[36.2972,59.6067];
      map.current=L.map(element.current,{scrollWheelZoom:true,zoomControl:true}).setView(center,points.length?15:14);
      const hot=L.tileLayer("https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",{subdomains:["a","b","c"],maxZoom:19,attribution:"© OpenStreetMap contributors, HOT",crossOrigin:true}).addTo(map.current);let fallbackAdded=false;hot.on("tileerror",()=>{if(fallbackAdded||!map.current)return;fallbackAdded=true;L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{subdomains:["a","b","c"],maxZoom:19,attribution:"© OpenStreetMap contributors"}).addTo(map.current);});
      layer.current=L.layerGroup().addTo(map.current);
      renderMarkers();
      setTimeout(()=>map.current&&map.current.invalidateSize(),150);
    };
    const renderMarkers=()=>{const L=(window as any).L;if(!map.current||!layer.current||!L)return;layer.current.clearLayers();const points=latest.current.locations;
      for(const p of points){const driver=latest.current.drivers.find(d=>d.id===p.driver_id);const marker=L.circleMarker([p.latitude,p.longitude],{radius:11,color:"#ffffff",weight:3,fillColor:"#075bff",fillOpacity:1}).addTo(layer.current);
        const nav="https://nshn.ir/?lat="+encodeURIComponent(p.latitude)+"&lng="+encodeURIComponent(p.longitude);
        marker.bindPopup("<b>"+(driver?.full_name||"راننده")+"</b><br/>آخرین ثبت: "+dateText(p.updated_at)+"<br/><a href='"+nav+"' target='_blank' rel='noreferrer'>مسیریابی با نشان</a>");
      }
      if(points.length===1)map.current.setView([points[0].latitude,points[0].longitude],15);
      else if(points.length>1)map.current.fitBounds(points.map(p=>[p.latitude,p.longitude]),{padding:[25,25]});
    };
    const w=window as any;if(w.L)init();else{if(!document.getElementById("mitra-leaflet-css")){const css=document.createElement("link");css.id="mitra-leaflet-css";css.rel="stylesheet";css.href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";document.head.appendChild(css);}let script=document.getElementById("mitra-leaflet-js") as HTMLScriptElement|null;if(!script){script=document.createElement("script");script.id="mitra-leaflet-js";script.src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";script.onload=init;script.onerror=()=>{};document.body.appendChild(script);}else if(w.L)init();else script.addEventListener("load",init,{once:true});}
    return()=>{cancelled=true;if(map.current){map.current.remove();map.current=null;layer.current=null;}};
  },[]);
  useEffect(()=>{const L=(window as any).L;if(!map.current||!layer.current||!L)return;layer.current.clearLayers();for(const p of locations){const driver=drivers.find(d=>d.id===p.driver_id);const marker=L.circleMarker([p.latitude,p.longitude],{radius:11,color:"#ffffff",weight:3,fillColor:"#075bff",fillOpacity:1}).addTo(layer.current);const nav="https://nshn.ir/?lat="+encodeURIComponent(p.latitude)+"&lng="+encodeURIComponent(p.longitude);marker.bindPopup("<b>"+(driver?.full_name||"راننده")+"</b><br/>آخرین ثبت: "+dateText(p.updated_at)+"<br/><a href='"+nav+"' target='_blank' rel='noreferrer'>مسیریابی با نشان</a>");}if(locations.length===1)map.current.setView([locations[0].latitude,locations[0].longitude],15);else if(locations.length>1)map.current.fitBounds(locations.map(p=>[p.latitude,p.longitude]),{padding:[25,25]});},[locations,drivers]);
  return <div className="map-picker"><b>موقعیت زنده راننده</b><small>نقطه آبی، آخرین مختصات ثبت‌شده راننده است. برای مسیریابی، نشان را باز کنید.</small><div ref={element} className="map-canvas live-driver-map"/></div>;
}

function RoundTripModal({drivers,onClose,onSubmit}:{drivers:Driver[];onClose:()=>void;onSubmit:(driverId:string,name:string,address:string,amount:number,note:string)=>Promise<void>;}) {
  const [driver,setDriver]=useState(drivers[0]?.id||"");const [name,setName]=useState("");const [address,setAddress]=useState("");const [amount,setAmount]=useState("");const [note,setNote]=useState("");const [busy,setBusy]=useState(false);
  return <Modal title="تعریف رفت‌وبرگشت با هزینه فروشگاه" onClose={onClose}><form className="form-stack" onSubmit={async e=>{e.preventDefault();setBusy(true);try{await onSubmit(driver,name,address,Number(normalizeDigits(amount)),note);}finally{setBusy(false);}}}><label>راننده<select value={driver} onChange={e=>setDriver(e.target.value)}>{drivers.map(d=><option key={d.id} value={d.id}>{d.full_name}</option>)}</select></label><Field label="نام مشتری" value={name} set={setName} required/><Field label="آدرس مقصد" value={address} set={setAddress}/><Field label="کرایه رفت‌وبرگشت (تومان)" value={amount} set={setAmount} type="number" required/><label>توضیحات<textarea rows={2} value={note} onChange={e=>setNote(e.target.value)}/></label><p className="muted">پس از انجام مسیر توسط راننده، درخواست برای تأیید فروشنده می‌آید و فقط بعد از تأیید به حساب راننده اضافه می‌شود.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>انصراف</button><button className="primary-button" disabled={busy||!driver||!name.trim()||Number(amount)<=0}>{busy?"در حال ثبت…":"تعریف مسیر رفت‌وبرگشت"}</button></div></form></Modal>;
}

function JalaliDateTimeField({value,onChange}:{value:string;onChange:(v:string)=>void}) {
  const parts=(v:string)=>{const d=v?new Date(v+":00+03:30"):new Date();const p=new Intl.DateTimeFormat("en-u-ca-persian",{timeZone:"Asia/Tehran",year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(d);const o=Object.fromEntries(p.map(x=>[x.type,x.value]));return {year:Number(o.year),month:Number(o.month),day:Number(o.day),hour:o.hour||"09",minute:o.minute||"00"};};
  const selected=parts(value);const [open,setOpen]=useState(false);const [view,setView]=useState({year:selected.year,month:selected.month});
  useEffect(()=>setView({year:selected.year,month:selected.month}),[value]);
  const monthNames=["فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور","مهر","آبان","آذر","دی","بهمن","اسفند"];
  function gregorianDay(jy:number,jm:number,jd:number){const fmt=new Intl.DateTimeFormat("en-u-ca-persian",{timeZone:"UTC",year:"numeric",month:"numeric",day:"numeric"});let lo=Math.floor(Date.UTC(jy+621,0,1)/86400000),hi=Math.floor(Date.UTC(jy+623,0,1)/86400000);while(lo<=hi){const mid=Math.floor((lo+hi)/2);const p=Object.fromEntries(fmt.formatToParts(new Date(mid*86400000)).map(x=>[x.type,x.value]));const y=Number(p.year),m=Number(p.month),d=Number(p.day);if(y===jy&&m===jm&&d===jd)return new Date(mid*86400000);if(y<jy||(y===jy&&(m<jm||(m===jm&&d<jd))))lo=mid+1;else hi=mid-1;}throw new Error("تاریخ شمسی معتبر نیست.");}
  function selectDay(day:number){const g=gregorianDay(view.year,view.month,day);const y=g.getUTCFullYear(),m=String(g.getUTCMonth()+1).padStart(2,"0"),d=String(g.getUTCDate()).padStart(2,"0");onChange(y+"-"+m+"-"+d+"T"+selected.hour+":"+selected.minute);setOpen(false);}
  function shiftMonth(delta:number){let month=view.month+delta,year=view.year;if(month<1){month=12;year--;}if(month>12){month=1;year++;}setView({year,month});}
  const first=gregorianDay(view.year,view.month,1);const next=gregorianDay(view.month===12?view.year+1:view.year,view.month===12?1:view.month+1,1);const count=Math.round((next.getTime()-first.getTime())/86400000);const offset=(first.getUTCDay()+1)%7;
  const dayCells=[...Array(offset).fill(0),...Array.from({length:count},(_,i)=>i+1)];
  return <div className="jalali-field"><div className="jalali-input-row"><input aria-label="تاریخ شمسی" value={selected.year+"/"+String(selected.month).padStart(2,"0")+"/"+String(selected.day).padStart(2,"0")} readOnly onClick={()=>setOpen(v=>!v)}/><input aria-label="ساعت" type="time" value={selected.hour+":"+selected.minute} onChange={e=>{const t=e.target.value||"09:00";onChange(value.slice(0,10)+"T"+t);}}/></div>
    <button type="button" className="small-button jalali-toggle" onClick={()=>setOpen(v=>!v)}>انتخاب از تقویم شمسی</button>
    {open&&<div className="jalali-calendar"><div className="jalali-calendar-head"><button type="button" onClick={()=>shiftMonth(1)}>‹</button><b>{monthNames[view.month-1]} {view.year.toLocaleString("fa-IR")}</b><button type="button" onClick={()=>shiftMonth(-1)}>›</button></div><div className="jalali-week">{["ش","ی","د","س","چ","پ","ج"].map(x=><span key={x}>{x}</span>)}</div><div className="jalali-days">{dayCells.map((day,i)=>day===0?<span key={"e"+i}/>:<button type="button" key={day} className={selected.year===view.year&&selected.month===view.month&&selected.day===day?"selected":""} onClick={()=>selectDay(day)}>{day.toLocaleString("fa-IR")}</button>)}</div></div>}
  </div>;
}

function Field({label,value,set,type="text",required=false}:{label:string;value:string;set:(v:string)=>void;type?:string;required?:boolean}){return <label>{label}<input type={type} min={type==="number"?"0":undefined} value={value} onChange={e=>set(e.target.value)} required={required}/></label>;}
function ReviewModal({check,onClose,onSubmit}:{check:Check;onClose:()=>void;onSubmit:(c:Check,a:boolean,n:string)=>Promise<void>}) {
  const [note,setNote]=useState("");const [busy,setBusy]=useState(false);
  return <Modal title="بررسی چک مشتری" onClose={onClose}><div className="form-stack"><p>مبلغ: <b>{money(check.total_amount_toman)}</b></p><p>تعداد: <b>{check.check_count.toLocaleString("fa-IR")} فقره</b></p><p className="muted">راننده تأیید کرده است؛ تصویر چک در این سامانه دریافت نمی‌شود.</p><label>یادداشت بررسی<textarea rows={3} value={note} onChange={e=>setNote(e.target.value)}/></label><div className="modal-actions"><button className="secondary-button" onClick={onClose}>انصراف</button><button className="danger-button" disabled={busy} onClick={async()=>{setBusy(true);try{await onSubmit(check,false,note);}finally{setBusy(false);}}}>رد چک</button><button className="primary-button" disabled={busy} onClick={async()=>{setBusy(true);try{await onSubmit(check,true,note);}finally{setBusy(false);}}}>{busy?"در حال ثبت…":"تأیید چک"}</button></div></div></Modal>;
}
function SettlementModal({driver,onClose,onSubmit}:{driver:Driver;onClose:()=>void;onSubmit:(amount:number,note:string)=>Promise<void>}){const [amount,setAmount]=useState("");const [note,setNote]=useState("");const [busy,setBusy]=useState(false);return <Modal title={`تسویه حساب ${driver.full_name}`} onClose={onClose}><form className="form-stack" onSubmit={e=>{e.preventDefault();const n=Number(amount);if(n>0){setBusy(true);void onSubmit(n,note).finally(()=>setBusy(false));}}}><Field label="مبلغ تسویه (تومان)" value={amount} set={setAmount} type="number" required/><label>توضیحات<textarea value={note} onChange={e=>setNote(e.target.value)} rows={2}/></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>انصراف</button><button className="primary-button" disabled={busy||!Number(amount)||Number(amount)<=0}>{busy?"در حال ثبت…":"ثبت تسویه"}</button></div></form></Modal>}

function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}) {return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="modal"><div className="modal-head"><h3>{title}</h3><button className="icon-button" onClick={onClose}><X size={18}/></button></div>{children}</section></div>;}

function DriverPanel({profile,tab,setTab,setError,setNotice}:{profile:Profile;tab:string;setTab:(v:string)=>void;setError:(v:string)=>void;setNotice:(v:string)=>void}) {
  const [missions,setMissions]=useState<Mission[]>([]); const [items,setItems]=useState<Record<string,MissionItem[]>>({}); const [extraJobs,setExtraJobs]=useState<ExtraJob[]>([]);
  const [ledger,setLedger]=useState<Ledger[]>([]); const [cashCollections,setCashCollections]=useState<CashCollection[]>([]); const [cashBusy,setCashBusy]=useState<string|null>(null); const [checksByOrder,setChecksByOrder]=useState<Record<string,CustomerCheck[]>>({}); const [busy,setBusy]=useState(false);
  const [visitOpen,setVisitOpen]=useState(false); const [activeMission,setActiveMission]=useState<string|null>(null);
  const [contactsOpen,setContactsOpen]=useState(false);const [positionOpen,setPositionOpen]=useState(false);
  const [driverPosition,setDriverPosition]=useState<{latitude:number;longitude:number}|null>(null);const [tracking,setTracking]=useState(false);const [lastLocationAt,setLastLocationAt]=useState<string|null>(null);const locationWatch=useRef<number|null>(null);const locationRefresh=useRef<number|null>(null);const locationNotified=useRef(false);const lastLocationWrite=useRef(0);const trackingBusy=useRef(false);
  const load=useCallback(async()=>{
    setBusy(true);setError("");
    try{
      const [m,extraResult,locationResult]=await Promise.all([supabase.from("missions").select("*").eq("driver_id",profile.id).neq("status","cancelled").order("created_at",{ascending:false}).limit(200),supabase.from("driver_extra_jobs").select("*").eq("driver_id",profile.id).is("deleted_at",null).order("created_at",{ascending:false}).limit(100),supabase.from("driver_locations").select("latitude,longitude,updated_at").eq("driver_id",profile.id).maybeSingle()]);
      if(m.error)throw m.error;if(extraResult.error)throw extraResult.error;if(locationResult.error)throw locationResult.error;setExtraJobs((extraResult.data||[]) as ExtraJob[]);if(locationResult.data){setDriverPosition({latitude:Number(locationResult.data.latitude),longitude:Number(locationResult.data.longitude)});setLastLocationAt(locationResult.data.updated_at||null);}
      const allLedger = await fetchAllLedger(profile.id);
      const ledgerOrderIds=[...new Set(allLedger.map(x=>x.order_id).filter(Boolean) as string[])];
      let ledgerDetails=new Map<string,{name:string;address:string}>();
      if(ledgerOrderIds.length){const lo=await supabase.from("orders").select("id,customer_id").in("id",ledgerOrderIds);if(lo.error)throw lo.error;const customerIds=[...new Set((lo.data||[]).map((x:any)=>x.customer_id))];if(customerIds.length){const lc=await supabase.from("customers").select("id,full_name,address").in("id",customerIds);if(lc.error)throw lc.error;const cm=new Map((lc.data||[]).map((x:any)=>[x.id,x]));for(const o of lo.data||[]){const c:any=cm.get(o.customer_id);if(c)ledgerDetails.set(o.id,{name:c.full_name,address:c.address});}}}
      const ledgerExtraIds=[...new Set(allLedger.map(x=>x.extra_job_id).filter(Boolean) as string[])];
      const ledgerExtras=ledgerExtraIds.length?await supabase.from("driver_extra_jobs").select("id,title,address").in("id",ledgerExtraIds):{data:[],error:null};
      if(ledgerExtras.error)throw ledgerExtras.error;
      const extraJobMap=new Map((ledgerExtras.data||[]).map((x:any)=>[x.id,x]));
      const detailedLedger=allLedger.map(x=>{
        if((x.description||"").includes("مشتری:")||(x.description||"").includes("مقصد:"))return x;
        if(x.order_id){const c=ledgerDetails.get(x.order_id);if(c)return {...x,description:(x.description||"کرایه سفارش")+" | مشتری: "+c.name+" | آدرس: "+c.address};}
        if(x.extra_job_id){const j=extraJobMap.get(x.extra_job_id);if(j)return {...x,description:(x.description||"کرایه مسیر")+" | مقصد: "+j.title+" | آدرس: "+(j.address||"ثبت نشده")};}
        return x;
      });
      const ms=(m.data||[]) as Mission[];setMissions(ms);setLedger(detailedLedger);
      const orderIds=[...new Set(ms.map(x=>x.order_id))];
      if(orderIds.length){
        const [cashResult,checkResult]=await Promise.all([supabase.from("cash_collections").select("id,order_id,amount_toman,status,created_at").in("order_id",orderIds).in("status",["pending","awaiting_driver"]),supabase.from("customer_checks").select("id,order_id,total_amount_toman,check_count,status,driver_confirmed_by,driver_confirmed_at").in("order_id",orderIds)]);if(cashResult.error)throw cashResult.error;if(checkResult.error)throw checkResult.error;setCashCollections((cashResult.data||[]) as CashCollection[]);const groupedChecks:Record<string,CustomerCheck[]>={};for(const ck of (checkResult.data||[]) as CustomerCheck[])(groupedChecks[ck.order_id]??=[]).push(ck);setChecksByOrder(groupedChecks);
        const [os,mi]=await Promise.all([
          supabase.from("orders").select("*").in("id",orderIds),
          supabase.from("mission_items").select("*").in("mission_id",ms.map(x=>x.id))
        ]);
        if(os.error)throw os.error;if(mi.error)throw mi.error;
        const orderMap=new Map((os.data||[]).map((x:any)=>[x.id,x]));
        const customerIds=[...new Set((os.data||[]).map((x:any)=>x.customer_id))];
        const [customerResult, phoneResult] = customerIds.length ? await Promise.all([
          supabase.from("customers").select("id,full_name,address,notes,latitude,longitude").in("id",customerIds),
          supabase.from("customer_phones").select("customer_id,phone,is_primary").in("customer_id",customerIds).order("is_primary",{ascending:false})
        ]) : [{data:[],error:null},{data:[],error:null}];
        if(customerResult.error)throw customerResult.error;
        if(phoneResult.error)throw phoneResult.error;
        const phoneMap = new Map<string,string[]>();
        for (const p of phoneResult.data || []) { const list=phoneMap.get(p.customer_id)||[];if(!list.includes(p.phone)&&list.length<2)list.push(p.phone);phoneMap.set(p.customer_id,list); }
        const customerMap=new Map((customerResult.data||[]).map((x:any)=>[x.id,{...x,phone:phoneMap.get(x.id)?.[0]||null,phone2:phoneMap.get(x.id)?.[1]||null}]));
        const itemsRaw=(mi.data||[]) as MissionItem[];
        const itemIds=[...new Set(itemsRaw.map(x=>x.order_item_id))];
        let itemMap=new Map<string,any>();
        if(itemIds.length){const oi=await supabase.from("order_items").select("id,mattress_name,brand,size,weight").in("id",itemIds);if(oi.error)throw oi.error;itemMap=new Map((oi.data||[]).map((x:any)=>[x.id,x]));}
        const byMission:Record<string,MissionItem[]>={};
        itemsRaw.forEach(x=>{x.item=itemMap.get(x.order_item_id)||null;(byMission as any)[x.mission_id]??=[];(byMission as any)[x.mission_id].push(x);});
        setItems(byMission);
        setMissions(ms.map(x=>{const order:any=orderMap.get(x.order_id);return {...x,order:order||null,customer:order?customerMap.get(order.customer_id)||null:null};}));
      } else {setItems({});setCashCollections([]);setChecksByOrder({});}
    }catch(e){setError(errorMessage(e,"بارگذاری مأموریت‌ها ناموفق بود."));}
    finally{setBusy(false);}
  },[profile.id,setError]);
  useEffect(()=>{load();},[load]);
  const sortedMissions=useMemo(()=>{
    const remaining=missions.filter(m=>m.customer?.latitude!=null&&m.customer?.longitude!=null);
    const missing=missions.filter(m=>m.customer?.latitude==null||m.customer?.longitude==null);
    if(remaining.length<2)return missions;
    let current=driverPosition||{latitude:remaining[0].customer!.latitude as number,longitude:remaining[0].customer!.longitude as number};
    let first=0;if(driverPosition){remaining.forEach((m,i)=>{const di=distanceKm(driverPosition,{latitude:m.customer!.latitude as number,longitude:m.customer!.longitude as number});const df=distanceKm(driverPosition,{latitude:remaining[first].customer!.latitude as number,longitude:remaining[first].customer!.longitude as number});if(di<df)first=i;});}
    const ordered=[remaining.splice(first,1)[0]];
    while(remaining.length){let best=0,bestDistance=Infinity;remaining.forEach((m,i)=>{const d=distanceKm(current,{latitude:m.customer!.latitude as number,longitude:m.customer!.longitude as number});if(d<bestDistance){best=i;bestDistance=d;}});const next=remaining.splice(best,1)[0];ordered.push(next);current={latitude:next.customer!.latitude as number,longitude:next.customer!.longitude as number};}
    return [...ordered,...missing];
  },[missions,driverPosition]);
  async function persistDriverPoint(point:{latitude:number;longitude:number},notify=true){
    if(!Number.isFinite(point.latitude)||!Number.isFinite(point.longitude)||point.latitude<24||point.latitude>40||point.longitude<44||point.longitude>64){if(notify)setError("مختصات انتخاب‌شده معتبر نیست؛ یک نقطه داخل ایران انتخاب کنید.");return false;}
    const now=new Date().toISOString();
    const r=await supabase.from("driver_locations").upsert({driver_id:profile.id,latitude:point.latitude,longitude:point.longitude,updated_at:now},{onConflict:"driver_id"});
    if(r.error){if(notify)setError("موقعیت دریافت شد اما در سرور ذخیره نشد: "+errorMessage(r.error));return false;}
    setDriverPosition(point);setLastLocationAt(now);lastLocationWrite.current=Date.now();if(notify)setNotice("موقعیت راننده ذخیره شد و ردیابی زنده فعال است.");return true;
  }
  async function saveManualDriverLocation(){
    if(!driverPosition){setError("ابتدا روی نقشه یک نقطه انتخاب کنید.");return;}
    if(await persistDriverPoint(driverPosition))setPositionOpen(false);
  }
  async function saveCurrentLocation(){
    if(!navigator.geolocation){setError("این مرورگر مکان‌یابی ندارد؛ از انتخاب مبدأ دستی استفاده کنید.");setPositionOpen(true);return;}
    if(!window.isSecureContext){setError("برای ردیابی زنده، سایت باید با HTTPS باز شود.");setPositionOpen(true);return;}
    if(locationWatch.current!==null){navigator.geolocation.clearWatch(locationWatch.current);locationWatch.current=null;}if(locationRefresh.current!==null){window.clearInterval(locationRefresh.current);locationRefresh.current=null;}
    locationNotified.current=false;trackingBusy.current=false;setTracking(false);setError("");setNotice("درخواست مکان‌یابی ارسال شد؛ اجازه دسترسی مرورگر را تأیید کنید.");
    const onPosition=async(pos:GeolocationPosition)=>{
      const point={latitude:pos.coords.latitude,longitude:pos.coords.longitude};
      if(trackingBusy.current)return;
      if(Date.now()-lastLocationWrite.current<5000)return;
      trackingBusy.current=true;
      try{await persistDriverPoint(point,false);setTracking(true);if(!locationNotified.current){setNotice("ردیابی زنده فعال است؛ تا وقتی پنل راننده باز و دسترسی مکان‌یابی مجاز باشد، موقعیت به‌روزرسانی می‌شود.");locationNotified.current=true;}}
      finally{trackingBusy.current=false;}
    };
    locationWatch.current=navigator.geolocation.watchPosition(onPosition,err=>{
      if(err.code===1){setTracking(false);setError("دسترسی مکان‌یابی رد شده است؛ مجوز Location مرورگر را فعال کنید.");}
      else if(!locationNotified.current){setError("در دریافت موقعیت وقفه افتاده است؛ مرورگر ممکن است موقتاً GPS یا شبکه مکان‌یابی را از دست داده باشد. ردیابی با دریافت موقعیت بعدی ادامه پیدا می‌کند.");}
    },{enableHighAccuracy:true,timeout:30000,maximumAge:0});
    locationRefresh.current=window.setInterval(()=>{if(document.visibilityState==="visible")navigator.geolocation.getCurrentPosition(onPosition,()=>{}, {enableHighAccuracy:true,timeout:20000,maximumAge:0});},30000);
    setTracking(true);
  }
  useEffect(()=>{
    const resume=()=>{if(document.visibilityState==="visible"&&locationWatch.current!==null&&navigator.geolocation){navigator.geolocation.getCurrentPosition(pos=>{void persistDriverPoint({latitude:pos.coords.latitude,longitude:pos.coords.longitude},false);},()=>{}, {enableHighAccuracy:true,timeout:20000,maximumAge:0});}};
    document.addEventListener("visibilitychange",resume);
    return()=>{document.removeEventListener("visibilitychange",resume);if(locationWatch.current!==null)navigator.geolocation.clearWatch(locationWatch.current);if(locationRefresh.current!==null)window.clearInterval(locationRefresh.current);locationWatch.current=null;locationRefresh.current=null;};
  },[]);
  async function deleteExtraJob(job:ExtraJob){if(!window.confirm("مسیر «"+job.title+"» و کرایه وابسته آن حذف شود؟"))return;try{const {error}=await supabase.rpc("go_delete_extra_job",{p_job_id:job.id});if(error)throw error;setNotice("مسیر و کرایه وابسته حذف شدند.");await load();}catch(e){setError(errorMessage(e,"حذف مسیر ناموفق بود."));}}
  async function completeExtraJob(job:ExtraJob){try{const {error}=await supabase.rpc("go_driver_complete_extra_job",{p_job_id:job.id});if(error)throw error;setNotice(job.job_type==="store_round_trip"?"رفت‌وبرگشت انجام شد و کرایه به حساب شما اضافه شد.":"مراجعه ثبت شد و برای تأیید فروشنده ارسال شد.");await load();}catch(e){setError(errorMessage(e,"ثبت پایان مسیر ویژه ناموفق بود."));}}
  async function status(m:Mission,next:string,reason?:string){
    try{const {error}=await supabase.rpc("driver_update_mission_status",{p_mission_id:m.id,p_new_status:next,p_failure_reason:reason||null});if(error)throw error;setNotice("وضعیت مأموریت به‌روزرسانی شد.");await load();}
    catch(e){setError(errorMessage(e,"تغییر وضعیت ناموفق بود."));}
  }
  async function updateItem(it:MissionItem,stage:"loaded"|"delivered"){
    try{
      const {error}=await supabase.rpc("driver_mark_mission_item_stage",{p_mission_item_id:it.id,p_stage:stage});
      if(error)throw error;setNotice(stage==="loaded"?"بارگیری کالا ثبت شد.":"خدا قوت ای مرد ❤️");await load();
    }catch(e){setError(errorMessage(e,"ثبت عملیات کالا ناموفق بود."));}
  }
  async function confirmCheck(c:CustomerCheck){try{const {error}=await supabase.rpc("driver_confirm_customer_check",{p_check_id:c.id});if(error)throw error;setNotice("تأیید چک برای بررسی فروشنده ارسال شد.");await load();}catch(e){setError(errorMessage(e,"تأیید چک ناموفق بود."));}}
  async function complete(m:Mission,freightCollected:boolean){
    try{const {error}=await supabase.rpc("driver_complete_mission",{p_mission_id:m.id,p_freight_collected:freightCollected});if(error)throw error;setNotice("اتمام مأموریت ثبت شد.");await load();}
    catch(e){setError(errorMessage(e,"اتمام مأموریت ناموفق بود."));}
  }
  async function markCash(c:CashCollection){if(cashBusy)return;setCashBusy(c.id);try{const {error}=await supabase.rpc("driver_mark_cash_received",{p_collection_id:c.id});if(error)throw error;setNotice("دریافت وجه نقد ثبت شد.");await load();}catch(e){setError(errorMessage(e,"ثبت دریافت وجه ناموفق بود."));}finally{setCashBusy(null);}}
  const todayMissions=sortedMissions.filter(m=>isTodayTehran(m.created_at));
  const archivedMissions=sortedMissions.filter(m=>!isTodayTehran(m.created_at));
  const nav=[{id:"home",label:"مأموریت‌های امروز",icon:<Truck size={17}/>},{id:"archive",label:"ماموریت‌های بایگانی‌شده",icon:<ClipboardList size={17}/>},{id:"extras",label:"مسیرهای ویژه",icon:<Warehouse size={17}/>},{id:"finance",label:"حساب من",icon:<Wallet size={17}/>}];
  return <><Nav tab={tab} setTab={setTab} items={nav}/>
    {(tab==="home"||tab==="archive")&&<><div className="stats-grid"><Stat label="کل مأموریت‌ها" value={missions.length}/><Stat label="فعال" value={missions.filter(m=>!["delivered","failed","cancelled"].includes(m.status)).length}/><Stat label="تکمیل‌شده" value={missions.filter(m=>m.status==="delivered").length}/><Stat label="مانده حساب (تومان)" value={ledger.reduce((s,x)=>s+x.amount_toman,0)}/></div>
      <SectionTitle title="مأموریت‌های من" sub="موقعیت فعلی را ثبت کنید تا نزدیک‌ترین نشانی اول نمایش داده شود." action={<><button className="small-button" onClick={saveCurrentLocation}><MapPin size={15}/> {tracking?"ردیابی زنده فعال است":"شروع ردیابی زنده"}</button><button className="small-button" onClick={()=>setPositionOpen(true)}><MapPin size={15}/> انتخاب مبدأ دستی</button><button className="small-button" onClick={load}><RefreshCw size={15}/> بروزرسانی</button><small className="muted">{tracking?"ردیابی زنده فعال است":lastLocationAt?"آخرین ثبت موقعیت: "+dateText(lastLocationAt):"ردیابی زنده خاموش است"}</small></>}/>
      <div className="stack">{(tab==="home"?todayMissions:archivedMissions).map(m=><MissionCard key={m.id} mission={m} items={items[m.id]||[]} onOpen={()=>setActiveMission(m.id)}/>)}
      {!(tab==="home"?todayMissions:archivedMissions).length&&<Empty text={tab==="home"?"امروز مأموریتی به شما ارجاع نشده است.":"مأموریت بایگانی‌شده‌ای وجود ندارد."}/>}</div>
      {activeMission&&<MissionModal mission={missions.find(m=>m.id===activeMission)!} driverPosition={driverPosition} items={items[activeMission]||[]} checks={checksByOrder[missions.find(m=>m.id===activeMission)!.order_id]||[]} pendingCash={cashCollections.filter(c=>c.order_id===missions.find(m=>m.id===activeMission)!.order_id)} cashBusy={cashBusy} onClose={()=>setActiveMission(null)} onStatus={status} onUpdateItem={updateItem} onComplete={complete} onConfirmCheck={confirmCheck} onMarkCash={markCash}/>}
      {positionOpen&&<Modal title="تعیین موقعیت شروع مسیر" onClose={()=>setPositionOpen(false)}><div className="form-stack"><p className="muted">نقطه شروع خود را روی نقشه لمس کنید؛ نشانی‌های تگ‌شده از نزدیک‌ترین به دورترین مرتب می‌شوند.</p><MapPicker latitude={driverPosition?.latitude??null} longitude={driverPosition?.longitude??null} onChange={(latitude,longitude)=>setDriverPosition({latitude,longitude})}/><button className="small-button" onClick={saveCurrentLocation}>استفاده از موقعیت فعلی من</button><button className="primary-button" disabled={!driverPosition} onClick={saveManualDriverLocation}>ذخیره مبدأ راننده</button></div></Modal>}
    </>}
    {tab==="extras"&&<><SectionTitle title="مسیرها و هزینه‌های ویژه" sub="رفت‌وبرگشت‌های تعریف‌شده توسط فروشنده و مراجعه‌های منتظر تأیید" action={<button className="primary-small" onClick={()=>setVisitOpen(true)}><Plus size={15}/> ثبت مراجعه به انبار دیگر</button>}/><div className="stack">{extraJobs.map(j=><div className="data-card" key={j.id}><div className="card-top"><b>{j.title}</b><Status value={j.status==="pending_approval"?"awaiting_seller":j.status}/></div><p>{j.address||"آدرس ثبت نشده"} · {money(j.amount_toman)}</p>{j.notes&&<small>{j.notes}</small>}{j.status==="assigned"&&<button className="primary-small" onClick={()=>completeExtraJob(j)}>{j.job_type==="store_round_trip"?"مسیر انجام شد؛ ثبت کرایه":"مسیر انجام شد؛ ارسال برای تأیید"}</button>}{j.status==="pending_approval"&&<small className="muted">در انتظار تأیید فروشنده؛ هنوز به حساب اضافه نشده است.</small>}{j.review_note&&<small>{j.review_note}</small>}{j.status!=="approved"&&j.status!=="rejected"&&<div className="card-bottom"><button className="danger-button" onClick={()=>deleteExtraJob(j)}>حذف مسیر</button></div>}</div>)}{!extraJobs.length&&<Empty text="مسیر ویژه‌ای ثبت نشده است."/>}</div>{visitOpen&&<WarehouseModal onClose={()=>setVisitOpen(false)} onDone={()=>{setVisitOpen(false);setNotice("درخواست هزینه برای تأیید فروشنده ثبت شد.");load();}} onError={setError}/>}</>}
    {tab==="finance"&&<><SectionTitle title="حساب راننده" sub="گردش حساب و کرایه‌های ثبت‌شده"/><div className="balance-card"><span>مانده حساب</span><strong>{money(ledger.reduce((s,x)=>s+x.amount_toman,0))}</strong></div><div className="stack">{ledger.map(x=><div className="data-card compact" key={x.id}><div className="card-top"><strong>{ledgerLabel(x.entry_type,x.description||"")}</strong><b className={x.amount_toman<0?"negative":"positive"}>{money(x.amount_toman)}</b></div><p>{x.description||"—"}</p><small>{dateText(x.created_at)}</small></div>)}{!ledger.length&&<Empty text="تراکنشی ثبت نشده است."/>}</div></>}
    {busy&&<div className="inline-loading"><Loader2 className="spin" size={16}/> در حال بروزرسانی…</div>}
    <div style={{position:"fixed",left:18,bottom:18,zIndex:8}}>
      {contactsOpen&&<div className="data-card" style={{width:245,marginBottom:10,boxShadow:"0 8px 30px #0008"}}>
        <div className="card-top"><strong>تماس‌های ضروری</strong><button className="icon-button" onClick={()=>setContactsOpen(false)} aria-label="بستن"><X size={15}/></button></div>
        {[["حسین نجفی","09045455385"],["آقایی","09155225532"],["امیررضا رحمانی","09059586495"]].map(([name,phone])=><a key={phone} href={`tel:${phone}`} style={{display:"flex",justifyContent:"space-between",padding:"11px 2px",borderBottom:"1px solid #302a39",color:"#e7d9f5",textDecoration:"none",fontSize:12}}><span>{name}</span><span dir="ltr">{phone}</span></a>)}
      </div>}
      <button className="primary-small" onClick={()=>setContactsOpen(v=>!v)} aria-label="تماس‌های ضروری" style={{width:52,height:52,borderRadius:"50%",boxShadow:"0 5px 20px #0008"}}><Phone size={21}/></button>
    </div>
  </>;
}
function MissionCard({mission,items,onOpen}:{mission:Mission;items:MissionItem[];onOpen:()=>void}) {
  return <button className="mission-card" onClick={onOpen}><div className="card-top"><strong>{mission.customer?.full_name||"مشتری"} · مأموریت #{mission.id.slice(0,8)}</strong><Status value={mission.status}/></div><p>{mission.customer?.address||"آدرس ثبت نشده"}</p><p>سفارش #{mission.order?.order_number?.toLocaleString("fa-IR")||"—"} · کرایه راننده: {money(mission.order?.driver_freight_toman)}</p><div className="card-bottom"><small>{items.length.toLocaleString("fa-IR")} قلم کالا · {dateText(mission.created_at)}</small><ChevronLeft size={18}/></div></button>;
}
function MissionModal({mission,driverPosition,items,checks,pendingCash,cashBusy,onClose,onStatus,onUpdateItem,onComplete,onConfirmCheck,onMarkCash}:{mission:Mission;driverPosition:{latitude:number;longitude:number}|null;items:MissionItem[];checks:CustomerCheck[];pendingCash:CashCollection[];cashBusy:string|null;onClose:()=>void;onStatus:(m:Mission,s:string,r?:string)=>Promise<void>;onUpdateItem:(i:MissionItem,stage:"loaded"|"delivered")=>Promise<void>;onComplete:(m:Mission,freightCollected:boolean)=>Promise<void>;onConfirmCheck:(c:CustomerCheck)=>Promise<void>;onMarkCash:(c:CashCollection)=>Promise<void>}) {
  const [reason,setReason]=useState("");const [saving,setSaving]=useState(false);const [freightCollected,setFreightCollected]=useState(false);
  async function runAction(action:()=>Promise<void>){if(saving)return;setSaving(true);try{await action();}finally{setSaving(false);}}
  const itemsReady=items.length>0&&items.every(i=>Number(i.loaded_quantity??0)===i.ordered_quantity&&Number(i.delivered_quantity??0)===i.ordered_quantity);
  const cashReady=pendingCash.length===0&&Number(mission.order?.customer_cash_balance_toman||0)<=0;
  const checksReady=checks.every(c=>c.status==="approved"&&!!c.driver_confirmed_at);
  const canComplete=itemsReady&&cashReady&&checksReady;
  const stages:Record<string,{label:string;next:string}>={assigned:{label:"پذیرش مأموریت",next:"accepted"},accepted:{label:"شروع بارگیری",next:"loading"},loading:{label:"حرکت به سمت مشتری",next:"on_the_way"}};
  return <Modal title="جزئیات مأموریت" onClose={onClose}><div className="form-stack">
    <div className="card-top"><strong>سفارش #{mission.order?.order_number?.toLocaleString("fa-IR")||"—"}</strong><Status value={mission.status}/></div>
    <div className="detail-box"><b>{mission.customer?.full_name||"اطلاعات مشتری"}</b><p>{mission.customer?.phone ? <>تلفن اول: <a href={"tel:"+mission.customer.phone}>{mission.customer.phone}</a></> : "شماره تماس ثبت نشده است."}{mission.customer?.phone2&&<> · تلفن دوم: <a href={"tel:"+mission.customer.phone2}>{mission.customer.phone2}</a></>}</p><p>{mission.customer?.address||"آدرس ثبت نشده است."}</p>
      {mission.customer?.latitude!=null&&mission.customer?.longitude!=null&&Number.isFinite(Number(mission.customer.latitude))&&Number.isFinite(Number(mission.customer.longitude))&&Number(mission.customer.latitude)!==0&&Number(mission.customer.longitude)!==0&&<p><a href={driverPosition&&Number.isFinite(driverPosition.latitude)&&Number.isFinite(driverPosition.longitude)?"https://nshn.ir/maps?origin="+encodeURIComponent(driverPosition.latitude+","+driverPosition.longitude)+"&destination="+encodeURIComponent(mission.customer.latitude+","+mission.customer.longitude)+"&type=drive":"https://nshn.ir/?lat="+mission.customer.latitude+"&lng="+mission.customer.longitude} target="_blank" rel="noreferrer">{driverPosition?"شروع مسیریابی با نشان":"نمایش مقصد ثبت‌شده در نشان"}</a></p>}
      <p>کرایه مشتری: {money(mission.order?.freight_toman)}</p><p>کرایه راننده: {money(mission.order?.driver_freight_toman)}</p><p>مانده نقدی: {money(mission.order?.customer_cash_balance_toman)}</p></div>
    <SectionTitle title="اقلام سفارش"/>
    {items.map(it=><div className="item-edit" key={it.id}><b>{it.item?.mattress_name||"کالای سفارش"}</b><span>تعداد سفارش: {it.ordered_quantity.toLocaleString("fa-IR")}</span>
      {mission.status==="loading"&&<button className="primary-small" disabled={saving||Number(it.loaded_quantity||0)===it.ordered_quantity} onClick={()=>runAction(()=>onUpdateItem(it,"loaded"))}>{Number(it.loaded_quantity||0)===it.ordered_quantity?"بارگیری ثبت شد":"بارگیری کردم"}</button>}
      {mission.status==="on_the_way"&&<><small>بارگیری: {Number(it.loaded_quantity||0)===it.ordered_quantity?"کامل":"ناقص"}</small><button className="primary-small" disabled={saving||Number(it.loaded_quantity||0)!==it.ordered_quantity||Number(it.delivered_quantity||0)===it.ordered_quantity} onClick={()=>runAction(()=>onUpdateItem(it,"delivered"))}>{Number(it.delivered_quantity||0)===it.ordered_quantity?"تحویل ثبت شد":"تحویل دادم"}</button></>}
    </div>)}
    {pendingCash.length>0&&<div className="detail-box"><b>مانده نقدی همین مشتری</b>{pendingCash.map(c=><div key={c.id} className="item-edit"><span>مبلغ: {money(c.amount_toman)}</span><Status value={c.status}/><button className="primary-small" disabled={cashBusy===c.id||mission.status!=="on_the_way"} onClick={()=>runAction(()=>onMarkCash(c))}>{cashBusy===c.id?"در حال ثبت…":"تأیید دریافت مانده نقدی"}</button></div>)}</div>}
    {checks.length>0&&<div className="detail-box"><b>چک‌های همین مشتری</b>{checks.map(c=><div key={c.id} className="item-edit"><span>{c.check_count.toLocaleString("fa-IR")} فقره · {money(c.total_amount_toman)}</span><Status value={c.status}/>{c.driver_confirmed_at?<small className="positive">تأیید راننده ثبت شده · {dateText(c.driver_confirmed_at)}</small>:<button className="primary-small" disabled={saving||mission.status!=="on_the_way"} onClick={()=>runAction(()=>onConfirmCheck(c))}>تأیید چک توسط راننده</button>}</div>)}</div>}
    {stages[mission.status]&&<><button className="primary-button" disabled={saving||(mission.status==="loading"&&(items.length===0||!items.every(i=>Number(i.loaded_quantity||0)===i.ordered_quantity)))} onClick={()=>runAction(()=>onStatus(mission,stages[mission.status].next))}>{stages[mission.status].label}</button>{mission.status==="loading"&&(items.length===0||!items.every(i=>Number(i.loaded_quantity||0)===i.ordered_quantity))&&<small className="muted">برای حرکت، دکمه «بارگیری کردم» را برای همه کالاها بزنید.</small>}</>}
    {mission.status==="on_the_way"&&<><div className="detail-box"><b>شرایط اتمام مأموریت</b><p>{itemsReady?"✓ همه کالاها تحویل شده‌اند":"× تحویل همه کالاها هنوز ثبت نشده"}</p><p>{cashReady?"✓ مانده نقدی تسویه شده":"× مانده نقدی مشتری باید تسویه شود"}</p><p>{checksReady?"✓ همه چک‌ها توسط راننده و فروشنده تأیید شده‌اند":"× تأیید راننده و فروشنده برای چک‌ها لازم است"}</p></div><label className="check-line"><input type="checkbox" checked={freightCollected} onChange={e=>setFreightCollected(e.target.checked)}/> کرایه مشتری دریافت شد</label><button className="primary-button" disabled={saving||!canComplete} onClick={()=>runAction(()=>onComplete(mission,freightCollected))}>اتمام مأموریت</button><small className="muted">تحویل کالا را می‌توانید ثبت کنید؛ اما تا تسویه مانده و تأیید چک توسط هر دو طرف، مأموریت باز می‌ماند.</small></>}
    {["accepted","loading","on_the_way"].includes(mission.status)&&<div className="failure-box"><label>ثبت عدم انجام مأموریت / علت شکست<textarea value={reason} onChange={e=>setReason(e.target.value)} rows={2}/></label><button className="danger-button" disabled={saving||!reason.trim()} onClick={()=>runAction(()=>onStatus(mission,"failed",reason))}>ثبت مأموریت ناموفق</button></div>}
    <div className="modal-actions"><button className="secondary-button" onClick={onClose}>بستن</button></div>
  </div></Modal>;
}
function WarehouseModal({onClose,onDone,onError}:{onClose:()=>void;onDone:()=>void;onError:(v:string)=>void}) {
  const [name,setName]=useState("");const [address,setAddress]=useState("");const [freight,setFreight]=useState("");const [notes,setNotes]=useState("");const [busy,setBusy]=useState(false);
  async function submit(e:FormEvent){e.preventDefault();setBusy(true);try{const {error}=await supabase.rpc("go_driver_submit_warehouse_visit",{p_title:name.trim(),p_address:address.trim()||null,p_amount_toman:Number(normalizeDigits(freight)),p_notes:notes.trim()||null});if(error)throw error;onDone();}catch(e){onError(errorMessage(e,"ثبت درخواست مراجعه ناموفق بود."));}finally{setBusy(false);}}
  return <Modal title="ثبت مراجعه به انبار شرکت دیگر" onClose={onClose}><form className="form-stack" onSubmit={submit}><Field label="نام شرکت / انبار" value={name} set={setName} required/><Field label="آدرس" value={address} set={setAddress}/><Field label="کرایه درخواستی (تومان)" value={freight} set={setFreight} type="number" required/><label>توضیحات<textarea rows={2} value={notes} onChange={e=>setNotes(e.target.value)}/></label><p className="muted">این مبلغ تا بررسی و تأیید فروشنده به حساب شما اضافه نمی‌شود.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>انصراف</button><button className="primary-button" disabled={busy}>{busy?"در حال ثبت…":"ارسال برای تأیید فروشنده"}</button></div></form></Modal>;
}
function ledgerLabel(t:string,description?:string){if(description?.startsWith("GO_MISSION_FREIGHT:"))return "کرایه مسیر";if(description?.startsWith("GO_EXTRA_JOB:"))return "هزینه ویژه تأییدشده";return ({uncollected_freight:"کرایه دریافت‌نشده",warehouse_visit:"مراجعه به انبار",settlement:"تسویه حساب",adjustment:"اصلاح حساب"} as Record<string,string>)[t]||t;}
