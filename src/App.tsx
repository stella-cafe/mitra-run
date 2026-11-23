import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
type Customer = { id: string; full_name: string; address: string; notes?: string | null; latitude?: number | null; longitude?: number | null; phone?: string | null };
type Driver = { id: string; full_name: string; phone: string | null };
type Order = {
  id: string; order_number: number; customer_id: string; status: string;
  freight_toman: number; customer_cash_balance_toman: number; checks_total_toman: number;
  checks_count: number; seller_notes: string | null; created_at: string;
};
type Mission = {
  id: string; order_id: string; driver_id: string; status: string; failure_reason?: string | null;
  order?: Order | null; customer?: Customer | null;
};
type MissionItem = {
  id: string; mission_id: string; order_item_id: string; ordered_quantity: number; loaded_quantity: number | null;
  delivered_quantity: number | null; discrepancy_note: string | null;
  item?: { mattress_name: string; brand: string | null; size: string | null; weight: string } | null;
};
type Check = { id: string; order_id: string; total_amount_toman: number; check_count: number; status: string; seller_review_note: string | null };
type Ledger = { id: string; driver_id?: string; entry_type: string; amount_toman: number; description: string | null; created_at: string };
type CashCollection = { id:string; order_id:string; amount_toman:number; status:string; created_at:string };
type CustomerCheck = {id:string;order_id:string;total_amount_toman:number;check_count:number;status:string};

function errorMessage(e: unknown, fallback = "عملیات ناموفق بود."): string {
  if (e && typeof e === "object") { const x = e as { message?: unknown; details?: unknown; hint?: unknown }; const parts = [x.message,x.details,x.hint].filter(v => typeof v === "string" && v.trim()) as string[]; if(parts.length)return parts.join(" — "); }
  return e instanceof Error ? e.message : fallback;
}
const money = (v?: number | null) => `${Number(v || 0).toLocaleString("fa-IR")} تومان`;
const dateText = (v?: string) => v ? new Date(v).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" }) : "—";
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
      .select("id,driver_id,entry_type,amount_toman,description,created_at")
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
    if (error) setError(error.message);
    setSession(null); setProfile(null); setTab("home"); setBusy(false);
  }

  if (loading) return <div className="loading-screen"><Loader2 className="spin" size={36}/><p>در حال بارگذاری MITRA RUN...</p></div>;
  if (!session || !profile) return <main className="login-page"><form className="login-card" onSubmit={login}>
    <div className="brand-icon"><Truck size={34}/></div><h1>MITRA RUN</h1>
    <p className="subtitle">سامانه مدیریت ارسال تشک میترا</p>
    <label>ایمیل</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="ایمیل حساب کاربری" autoComplete="username" required/>
    <label>رمز عبور</label><div style={{display:"flex",gap:8,alignItems:"center"}}><input style={{flex:1}} type={showPassword?"text":"password"} value={password} onChange={e=>setPassword(e.target.value)} placeholder="رمز عبور" autoComplete="current-password" required/><button type="button" className="icon-button" aria-label={showPassword?"پنهان کردن رمز عبور":"نمایش رمز عبور"} onClick={()=>setShowPassword(v=>!v)}>{showPassword?<EyeOff size={18}/>:<Eye size={18}/>}</button></div>
    {error && <div className="error">{error}</div>}
    <button className="primary-button" disabled={busy}>{busy ? "در حال ورود..." : "ورود به سامانه"}</button>
    <span className="version">MITRA RUN • VERSION 1.1</span>
  </form></main>;

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark"><Truck size={23}/></span><div><strong>MITRA RUN</strong><small>مدیریت ارسال میترا</small></div></div>
      <div className="user-actions"><span className="user-name">{profile.full_name || session.user.email}</span><button className="icon-button" onClick={logout} title="خروج"><LogOut size={18}/></button></div>
    </header>
    <div className="page-heading"><div><span className="eyebrow">خوش آمدید</span><h1>{profile.role === "seller" ? "پنل فروشنده" : "پنل راننده"}</h1><p>{profile.role === "seller" ? "مدیریت سفارش‌ها، رانندگان و امور مالی" : "مأموریت‌ها و عملیات روزانه شما"}</p></div>
      <span className="role-pill">{profile.role === "seller" ? "فروشنده" : "راننده"}</span></div>
    {error && <div className="alert error-alert"><AlertCircle size={17}/>{error}<button onClick={()=>setError("")}><X size={15}/></button></div>}
    {notice && <div className="alert success-alert"><CheckCircle2 size={17}/>{notice}<button onClick={()=>setNotice("")}><X size={15}/></button></div>}
    {profile.role === "seller" ? <SellerPanel profile={profile} tab={tab} setTab={setTab} setError={setError} setNotice={setNotice}/> :
      <DriverPanel profile={profile} tab={tab} setTab={setTab} setError={setError} setNotice={setNotice}/>}
    <footer>MITRA RUN © 2026</footer>
  </main>;
}

function Nav({tab,setTab,items}:{tab:string;setTab:(v:string)=>void;items:{id:string;label:string;icon:ReactNode}[]}) {
  return <nav className="nav-tabs">{items.map(i=><button key={i.id} className={tab===i.id?"active":""} onClick={()=>setTab(i.id)}>{i.icon}<span>{i.label}</span></button>)}</nav>;
}
function SectionTitle({title,sub,action}:{title:string;sub?:string;action?:ReactNode}) {
  return <div className="section-title"><div><h2>{title}</h2>{sub&&<p>{sub}</p>}</div>{action}</div>;
}
function Empty({text}:{text:string}) { return <div className="empty-state"><Package size={30}/><p>{text}</p></div>; }

function SellerPanel({profile,tab,setTab,setError,setNotice}:{profile:Profile;tab:string;setTab:(v:string)=>void;setError:(v:string)=>void;setNotice:(v:string)=>void}) {
  const [orders,setOrders] = useState<Order[]>([]);
  const [drivers,setDrivers] = useState<Driver[]>([]);
  const [customers,setCustomers] = useState<Customer[]>([]);
  const [checks,setChecks] = useState<Check[]>([]);
  const [ledger,setLedger] = useState<Ledger[]>([]);
  const [busy,setBusy] = useState(false);
  const [showOrder,setShowOrder] = useState(false);
  const [assigning,setAssigning] = useState<Order|null>(null);
  const [reviewing,setReviewing] = useState<Check|null>(null);
  const [settling,setSettling] = useState<Driver|null>(null);
  const [checkPhotos,setCheckPhotos] = useState<Record<string,string[]>>({});
  const [editingOrder,setEditingOrder] = useState<Order|null>(null);
  const [editingOrder,setEditingOrder] = useState<Order|null>(null);

  const load = useCallback(async()=>{
    setBusy(true); setError("");
    try {
      const [o,d,c,ch] = await Promise.all([
        supabase.from("orders").select("*").order("created_at",{ascending:false}).limit(100),
        supabase.from("profiles").select("id,full_name,phone").eq("role","driver").eq("is_active",true),
        supabase.from("customers").select("id,full_name,address,notes,latitude,longitude").eq("is_archived",false).order("full_name"),
        supabase.from("customer_checks").select("*").order("created_at",{ascending:false}).limit(100)
      ]);
      for (const r of [o,d,c,ch]) if (r.error) throw r.error;
      const allLedger = await fetchAllLedger();
      setOrders((o.data||[]) as Order[]); setDrivers((d.data||[]) as Driver[]);
      const customerRows=(c.data||[]) as Customer[];
      if(customerRows.length){
        const phones=await supabase.from("customer_phones").select("customer_id,phone,is_primary").in("customer_id",customerRows.map(x=>x.id)).order("is_primary",{ascending:false});
        if(phones.error)throw phones.error;
        const primary=new Map<string,string>();
        for(const p of phones.data||[])if(!primary.has(p.customer_id))primary.set(p.customer_id,p.phone);
        setCustomers(customerRows.map(x=>({...x,phone:primary.get(x.id)||null})));
      }else setCustomers([]);
      setChecks((ch.data||[]) as Check[]); setLedger(allLedger);
      const checkIds=(ch.data||[]).map((x:any)=>x.id);
      if(checkIds.length){const ph=await supabase.from("check_photos").select("id,check_id,storage_path,expires_at,deleted_at").in("check_id",checkIds).is("deleted_at",null);if(ph.error)throw ph.error;const grouped:Record<string,string[]>={};for(const x of ph.data||[]){if(x.expires_at && new Date(x.expires_at)<new Date())continue;const signed=await supabase.storage.from("mitra-private").createSignedUrl(x.storage_path,1800);if(!signed.error&&signed.data?.signedUrl)(grouped[x.check_id]??=[]).push(signed.data.signedUrl);}setCheckPhotos(grouped);}else setCheckPhotos({});
    } catch(e) { setError(e instanceof Error?e.message:"بارگذاری اطلاعات ناموفق بود."); }
    finally { setBusy(false); }
  },[setError]);
  useEffect(()=>{load();},[load]);

  async function assign(order:Order,driverId:string) {
    try { const {error}=await supabase.rpc("seller_assign_order",{p_order_id:order.id,p_driver_id:driverId}); if(error) throw error;
      setNotice("سفارش با موفقیت به راننده ارجاع شد."); setAssigning(null); await load();
    } catch(e){setError(e instanceof Error?e.message:"ارجاع سفارش ناموفق بود.");}
  }
  async function review(check:Check,approved:boolean,note:string) {
    try {const {error}=await supabase.rpc("seller_review_check",{p_check_id:check.id,p_approved:approved,p_note:note||null});if(error)throw error;
      setNotice(approved?"چک تأیید شد.":"چک رد شد.");setReviewing(null);await load();
    }catch(e){setError(e instanceof Error?e.message:"ثبت بررسی چک ناموفق بود.");}
  }

  async function settle(driver:Driver,amount:number,note:string){try{const {error}=await supabase.rpc("seller_settle_driver",{p_driver_id:driver.id,p_amount_toman:amount,p_note:note||null,p_receipt_path:null});if(error)throw error;setNotice("تسویه راننده با موفقیت ثبت شد.");setSettling(null);await load();}catch(e){setError(e instanceof Error?e.message:"ثبت تسویه ناموفق بود.");}}

  const nav=[{id:"home",label:"نمای کلی",icon:<ClipboardList size={17}/>},{id:"orders",label:"سفارش‌ها",icon:<Package size={17}/>},{id:"checks",label:"چک‌ها",icon:<FileCheck size={17}/>},{id:"finance",label:"مالی رانندگان",icon:<Wallet size={17}/>},{id:"customers",label:"مشتریان",icon:<Users size={17}/>}];
  const openOrders=orders.filter(o=>!["delivered","partially_delivered","failed","cancelled"].includes(o.status));
  return <>
    <Nav tab={tab} setTab={setTab} items={nav}/>
    {tab==="home"&&<><div className="stats-grid"><Stat label="کل سفارش‌ها" value={orders.length}/><Stat label="در جریان" value={openOrders.length}/><Stat label="رانندگان فعال" value={drivers.length}/><Stat label="چک‌های منتظر بررسی" value={checks.filter(c=>c.status==="awaiting_seller").length}/></div>
      <SectionTitle title="آخرین سفارش‌ها" action={<button className="small-button" onClick={load}><RefreshCw size={15}/> بروزرسانی</button>}/>
      <OrderList orders={orders.slice(0,6)} onAssign={setAssigning} onEdit={setEditingOrder}/></>}
    {tab==="orders"&&<><SectionTitle title="مدیریت سفارش‌ها" sub="ثبت سفارش جدید و ارجاع به راننده" action={<button className="primary-small" onClick={()=>setShowOrder(true)}><Plus size={16}/> ثبت سفارش</button>}/><OrderList orders={orders} onAssign={setAssigning} onEdit={setEditingOrder}/></>}
    {tab==="checks"&&<><SectionTitle title="مدیریت چک‌های مشتریان" sub="چک‌های تأییدشده توسط راننده را بررسی کنید"/><div className="stack">{checks.map(c=><div className="data-card" key={c.id}><div className="card-top"><strong>سفارش #{c.order_id.slice(0,8)}</strong><Status value={c.status}/></div><p>{c.check_count.toLocaleString("fa-IR")} فقره چک · {money(c.total_amount_toman)}</p>{c.status==="awaiting_seller"&&<button className="primary-small" onClick={()=>setReviewing(c)}>بررسی مدارک</button>}{c.seller_review_note&&<small>یادداشت: {c.seller_review_note}</small>}</div>)}{!checks.length&&<Empty text="هنوز چکی ثبت نشده است."/>}</div></>}
    {tab==="finance"&&<><SectionTitle title="دفتر مالی رانندگان" sub="مانده هر راننده و ثبت تسویه"/><div className="stack">{drivers.map(d=>{const rows=ledger.filter(x=>x.driver_id===d.id);const balance=rows.reduce((sum,x)=>sum+x.amount_toman,0);return <div className="data-card" key={d.id}><div className="card-top"><strong>{d.full_name}</strong><b className={balance<0?"negative":"positive"}>{money(balance)}</b></div><small>{d.phone||"شماره تماس ثبت نشده"}</small><button className="primary-small" disabled={balance<=0} onClick={()=>setSettling(d)}>ثبت تسویه</button></div>;})}{!drivers.length&&<Empty text="راننده فعالی وجود ندارد."/>}</div><SectionTitle title="آخرین تراکنش‌ها"/><div className="stack">{ledger.slice(0,40).map(x=><div className="data-card compact" key={x.id}><div className="card-top"><strong>{ledgerLabel(x.entry_type)}</strong><b className={x.amount_toman<0?"negative":"positive"}>{money(x.amount_toman)}</b></div><p>{x.description||"بدون توضیحات"}</p><small>{dateText(x.created_at)}</small></div>)}</div></>}
    {tab==="customers"&&<><SectionTitle title="مشتریان" sub={`${customers.length.toLocaleString("fa-IR")} مشتری ثبت‌شده`}/><div className="stack">{customers.map(c=><div className="data-card compact" key={c.id}><strong>{c.full_name}</strong><p>{c.address}</p>{c.notes&&<small>{c.notes}</small>}</div>)}{!customers.length&&<Empty text="مشتری‌ای ثبت نشده است."/>}</div></>}
    {showOrder&&<OrderModal customers={customers} drivers={drivers} onClose={()=>setShowOrder(false)} onDone={async()=>{setShowOrder(false);setNotice("سفارش با موفقیت ثبت شد.");await load();}} onError={setError}/>}
    {assigning&&<AssignModal order={assigning} drivers={drivers} onClose={()=>setAssigning(null)} onAssign={assign}/>}
    {reviewing&&<ReviewModal check={reviewing} photos={checkPhotos[reviewing.id]||[]} onClose={()=>setReviewing(null)} onSubmit={review}/>}
    {settling&&<SettlementModal driver={settling} onClose={()=>setSettling(null)} onSubmit={(amount,note)=>settle(settling,amount,note)}/> }
    {busy&&<div className="inline-loading"><Loader2 className="spin" size={16}/> در حال بروزرسانی…</div>}
  </>;
}

function Stat({label,value}:{label:string;value:number}) {return <div className="stat-card"><span>{label}</span><strong>{value.toLocaleString("fa-IR")}</strong></div>;}
function Status({value}:{value:string}) {return <span className={`status status-${value}`}>{statusFa[value]||value}</span>;}
function OrderList({orders,onAssign,onEdit}:{orders:Order[];onAssign:(o:Order)=>void;onEdit:(o:Order)=>void}) {
  return <div className="stack">{orders.map(o=><div className="data-card" key={o.id}><div className="card-top"><strong>سفارش #{o.order_number.toLocaleString("fa-IR")}</strong><Status value={o.status}/></div>
    <div className="card-grid"><span>شناسه مشتری: {o.customer_id.slice(0,8)}</span><span>کرایه: {money(o.freight_toman)}</span><span>مانده نقدی: {money(o.customer_cash_balance_toman)}</span><span>چک: {money(o.checks_total_toman)}</span></div>
    {o.seller_notes&&<p>{o.seller_notes}</p>}<div className="card-bottom"><small>{dateText(o.created_at)}</small><><button className="small-button" onClick={()=>onEdit(o)}>ویرایش سفارش</button>{o.status==="registered"&&<button className="small-button" onClick={()=>onAssign(o)}>ارجاع به راننده <ChevronLeft size={15}/></button>}</></div></div>)}
    {!orders.length&&<Empty text="سفارشی برای نمایش وجود ندارد."/>}</div>;
}

function OrderModal({customers,drivers,onClose,onDone,onError}:{customers:Customer[];drivers:Driver[];onClose:()=>void;onDone:()=>void;onError:(v:string)=>void}) {
  const [customerId,setCustomerId]=useState(""); const [fullName,setFullName]=useState(""); const [phone,setPhone]=useState("");
  const [address,setAddress]=useState(""); const [freight,setFreight]=useState("0"); const [cash,setCash]=useState("0");
  const [checksTotal,setChecksTotal]=useState("0"); const [checksCount,setChecksCount]=useState("0");
  const [notes,setNotes]=useState(""); const [driverId,setDriverId]=useState("");
  const [itemName,setItemName]=useState(""); const [brand,setBrand]=useState(""); const [size,setSize]=useState("");
  const [quantity,setQuantity]=useState("1"); const [weight,setWeight]=useState("medium"); const [itemNotes,setItemNotes]=useState("");
  const [busy,setBusy]=useState(false);
  const chosen=customers.find(c=>c.id===customerId);
  function chooseCustomer(id:string){setCustomerId(id);const c=customers.find(x=>x.id===id);if(c){setFullName(c.full_name);setAddress(c.address);}}
  async function submit(e:FormEvent){
    e.preventDefault();
    if(!fullName.trim()||!phone.trim()||!address.trim()||!itemName.trim()){
      onError("برای ثبت سفارش، نام مشتری، شماره تماس، آدرس کامل و نام تشک الزامی است.");return;
    }
    if(!/^0?9\d{9}$/.test(phone.replace(/[\s-]/g,""))){
      onError("شماره تماس معتبر وارد کنید.");return;
    }
    if(!Number.isInteger(Number(quantity))||Number(quantity)<1){
      onError("تعداد کالا باید عدد صحیح و حداقل ۱ باشد.");return;
    }
    if([freight,cash,checksTotal,checksCount].some(v=>!Number.isFinite(Number(v))||Number(v)<0)){
      onError("مبالغ و تعداد چک نمی‌توانند منفی یا نامعتبر باشند.");return;
    }
    if((Number(checksTotal)>0)!==(Number(checksCount)>0)){
      onError("برای چک، هم مبلغ و هم تعداد را وارد کنید.");return;
    }
    setBusy(true);
    try{
      const {error}=await supabase.rpc("seller_create_order",{
        p_customer_id:customerId||null,p_full_name:fullName.trim(),p_address:address.trim(),p_phone:phone.trim(),
        p_latitude:null,p_longitude:null,p_freight_toman:Number(freight||0),p_cash_balance_toman:Number(cash||0),
        p_checks_total_toman:Number(checksTotal||0),p_checks_count:Number(checksCount||0),p_seller_notes:notes.trim()||null,
        p_items:[{mattress_name:itemName.trim(),brand:brand.trim()||null,size:size.trim()||null,quantity:Number(quantity),weight,notes:itemNotes.trim()||null}],
        p_driver_id:driverId||null
      });
      if(error)throw error;onDone();
    }catch(e){onError(e instanceof Error?e.message:"ثبت سفارش انجام نشد.");}
    finally{setBusy(false);}
  }
  return <Modal title="ثبت سفارش جدید" onClose={onClose}><form className="form-grid" onSubmit={submit}>
    <label className="full">مشتری قبلی (اختیاری)<select value={customerId} onChange={e=>chooseCustomer(e.target.value)}><option value="">ثبت مشتری جدید</option>{customers.map(c=><option key={c.id} value={c.id}>{c.full_name} — {c.address}</option>)}</select></label>
    <Field label="نام مشتری" value={fullName} set={setFullName} required/><Field label="شماره تماس" value={phone} set={setPhone} required/>
    <label className="full">آدرس تحویل<textarea value={address} onChange={e=>setAddress(e.target.value)} required rows={2}/></label>
    <div className="full divider-label">مشخصات کالا</div><Field label="نام تشک" value={itemName} set={setItemName} required/><Field label="برند" value={brand} set={setBrand}/>
    <Field label="سایز" value={size} set={setSize}/><Field label="تعداد" value={quantity} set={setQuantity} type="number" required/>
    <label>وزن کالا<select value={weight} onChange={e=>setWeight(e.target.value)}><option value="light">سبک</option><option value="medium">متوسط</option><option value="heavy">سنگین</option></select></label>
    <Field label="کرایه (تومان)" value={freight} set={setFreight} type="number"/><Field label="مانده نقدی مشتری (تومان)" value={cash} set={setCash} type="number"/>
    <Field label="مبلغ چک‌ها (تومان)" value={checksTotal} set={setChecksTotal} type="number"/><Field label="تعداد چک" value={checksCount} set={setChecksCount} type="number"/>
    <label className="full">ارجاع مستقیم به راننده (اختیاری)<select value={driverId} onChange={e=>setDriverId(e.target.value)}><option value="">فعلاً ارجاع نشود</option>{drivers.map(d=><option key={d.id} value={d.id}>{d.full_name}</option>)}</select></label>
    <label className="full">توضیحات فروشنده<textarea value={notes} onChange={e=>setNotes(e.target.value)} rows={2}/></label>
    <div className="modal-actions full"><button type="button" className="secondary-button" onClick={onClose}>انصراف</button><button className="primary-button" disabled={busy}>{busy?"در حال ثبت…":"ثبت سفارش"}</button></div>
  </form></Modal>;
}
function Field({label,value,set,type="text",required=false}:{label:string;value:string;set:(v:string)=>void;type?:string;required?:boolean}){return <label>{label}<input type={type} min={type==="number"?"0":undefined} value={value} onChange={e=>set(e.target.value)} required={required}/></label>;}
function AssignModal({order,drivers,onClose,onAssign}:{order:Order;drivers:Driver[];onClose:()=>void;onAssign:(o:Order,id:string)=>void}) {
  const [id,setId]=useState(drivers[0]?.id||"");
  return <Modal title={`ارجاع سفارش #${order.order_number}`} onClose={onClose}><div className="form-stack"><label>انتخاب راننده<select value={id} onChange={e=>setId(e.target.value)}>{drivers.map(d=><option key={d.id} value={d.id}>{d.full_name} {d.phone||""}</option>)}</select></label>
    {!drivers.length&&<p className="muted">راننده فعال پیدا نشد.</p>}<div className="modal-actions"><button className="secondary-button" onClick={onClose}>انصراف</button><button className="primary-button" disabled={!id} onClick={()=>onAssign(order,id)}>تأیید ارجاع</button></div></div></Modal>;
}
function ReviewModal({check,photos,onClose,onSubmit}:{check:Check;photos:string[];onClose:()=>void;onSubmit:(c:Check,a:boolean,n:string)=>void}) {
  const [note,setNote]=useState("");
  return <Modal title="بررسی چک مشتری" onClose={onClose}><div className="form-stack"><p>مبلغ: <b>{money(check.total_amount_toman)}</b></p><p>تعداد: <b>{check.check_count.toLocaleString("fa-IR")} فقره</b></p><p className="muted">تصاویر بارگذاری‌شده چک:</p>{photos.length?<div className="photo-grid">{photos.map((url,i)=><a key={i} href={url} target="_blank" rel="noreferrer"><img src={url} alt={`تصویر چک ${i+1}`}/></a>)}</div>:<p className="muted">تصویر معتبر و در دسترسی برای این چک ثبت نشده است.</p>}<label>یادداشت بررسی<textarea rows={3} value={note} onChange={e=>setNote(e.target.value)}/></label><div className="modal-actions"><button className="secondary-button" onClick={onClose}>انصراف</button><button className="danger-button" onClick={()=>onSubmit(check,false,note)}>رد چک</button><button className="primary-button" onClick={()=>onSubmit(check,true,note)}>تأیید چک</button></div></div></Modal>;
}

function SettlementModal({driver,onClose,onSubmit}:{driver:Driver;onClose:()=>void;onSubmit:(amount:number,note:string)=>void}){const [amount,setAmount]=useState("");const [note,setNote]=useState("");return <Modal title={`تسویه حساب ${driver.full_name}`} onClose={onClose}><form className="form-stack" onSubmit={e=>{e.preventDefault();const n=Number(amount);if(n>0)onSubmit(n,note);}}><Field label="مبلغ تسویه (تومان)" value={amount} set={setAmount} type="number" required/><label>توضیحات<textarea value={note} onChange={e=>setNote(e.target.value)} rows={2}/></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>انصراف</button><button className="primary-button" disabled={!Number(amount)||Number(amount)<=0}>ثبت تسویه</button></div></form></Modal>}

function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}) {return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="modal"><div className="modal-head"><h3>{title}</h3><button className="icon-button" onClick={onClose}><X size={18}/></button></div>{children}</section></div>;}

function DriverPanel({profile,tab,setTab,setError,setNotice}:{profile:Profile;tab:string;setTab:(v:string)=>void;setError:(v:string)=>void;setNotice:(v:string)=>void}) {
  const [missions,setMissions]=useState<Mission[]>([]); const [items,setItems]=useState<Record<string,MissionItem[]>>({});
  const [ledger,setLedger]=useState<Ledger[]>([]); const [cashCollections,setCashCollections]=useState<CashCollection[]>([]); const [checksByOrder,setChecksByOrder]=useState<Record<string,CustomerCheck[]>>({}); const [busy,setBusy]=useState(false);
  const [visitOpen,setVisitOpen]=useState(false); const [activeMission,setActiveMission]=useState<string|null>(null);
  const [contactsOpen,setContactsOpen]=useState(false);
  const load=useCallback(async()=>{
    setBusy(true);setError("");
    try{
      const m=await supabase.from("missions").select("*").eq("driver_id",profile.id).order("created_at",{ascending:false}).limit(100);
      if(m.error)throw m.error;
      const allLedger = await fetchAllLedger(profile.id);
      const ms=(m.data||[]) as Mission[];setMissions(ms);setLedger(allLedger);
      const orderIds=[...new Set(ms.map(x=>x.order_id))];
      if(orderIds.length){
        const [cashResult,checkResult]=await Promise.all([supabase.from("cash_collections").select("id,order_id,amount_toman,status,created_at").in("order_id",orderIds).eq("status","pending"),supabase.from("customer_checks").select("id,order_id,total_amount_toman,check_count,status").in("order_id",orderIds)]);if(cashResult.error)throw cashResult.error;if(checkResult.error)throw checkResult.error;setCashCollections((cashResult.data||[]) as CashCollection[]);const groupedChecks:Record<string,CustomerCheck[]>={};for(const ck of (checkResult.data||[]) as CustomerCheck[])(groupedChecks[ck.order_id]??=[]).push(ck);setChecksByOrder(groupedChecks);
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
        const primaryPhones = new Map<string,string>();
        for (const p of phoneResult.data || []) {
          if (!primaryPhones.has(p.customer_id)) primaryPhones.set(p.customer_id,p.phone);
        }
        const customerMap=new Map((customerResult.data||[]).map((x:any)=>[x.id,{...x,phone:primaryPhones.get(x.id)||null}]));
        const itemsRaw=(mi.data||[]) as MissionItem[];
        const itemIds=[...new Set(itemsRaw.map(x=>x.order_item_id))];
        let itemMap=new Map<string,any>();
        if(itemIds.length){const oi=await supabase.from("order_items").select("id,mattress_name,brand,size,weight").in("id",itemIds);if(oi.error)throw oi.error;itemMap=new Map((oi.data||[]).map((x:any)=>[x.id,x]));}
        const byMission:Record<string,MissionItem[]>={};
        itemsRaw.forEach(x=>{x.item=itemMap.get(x.order_item_id)||null;(byMission as any)[x.mission_id]??=[];(byMission as any)[x.mission_id].push(x);});
        setItems(byMission);
        setMissions(ms.map(x=>{const order:any=orderMap.get(x.order_id);return {...x,order:order||null,customer:order?customerMap.get(order.customer_id)||null:null};}));
      } else {setItems({});setCashCollections([]);setChecksByOrder({});}
    }catch(e){setError(e instanceof Error?e.message:"بارگذاری مأموریت‌ها ناموفق بود.");}
    finally{setBusy(false);}
  },[profile.id,setError]);
  useEffect(()=>{load();},[load]);
  async function status(m:Mission,next:string,reason?:string){
    try{const {error}=await supabase.rpc("driver_update_mission_status",{p_mission_id:m.id,p_new_status:next,p_failure_reason:reason||null});if(error)throw error;setNotice("وضعیت مأموریت به‌روزرسانی شد.");await load();}
    catch(e){setError(e instanceof Error?e.message:"تغییر وضعیت ناموفق بود.");}
  }
  async function updateItem(it:MissionItem,loaded:number,delivered:number,note:string){
    try{const {error}=await supabase.rpc("driver_update_mission_item",{p_mission_item_id:it.id,p_loaded_quantity:loaded,p_delivered_quantity:delivered,p_discrepancy_note:note||null});if(error)throw error;setNotice("تعداد کالا به‌روزرسانی شد.");await load();}
    catch(e){setError(e instanceof Error?e.message:"ثبت تعداد ناموفق بود.");}
  }
  async function complete(m:Mission,freightCollected:boolean){
    try{const {error}=await supabase.rpc("driver_complete_mission",{p_mission_id:m.id,p_freight_collected:freightCollected});if(error)throw error;setNotice("اتمام مأموریت ثبت شد.");await load();}
    catch(e){setError(e instanceof Error?e.message:"اتمام مأموریت ناموفق بود.");}
  }
  async function markCash(c:CashCollection){try{const {error}=await supabase.rpc("driver_mark_cash_received",{p_collection_id:c.id});if(error)throw error;setNotice("دریافت وجه نقد ثبت شد.");await load();}catch(e){setError(e instanceof Error?e.message:"ثبت دریافت وجه ناموفق بود.");}}
  const nav=[{id:"home",label:"مأموریت‌ها",icon:<Truck size={17}/>},{id:"finance",label:"حساب من",icon:<Wallet size={17}/>}];
  return <><Nav tab={tab} setTab={setTab} items={nav}/>
    {tab==="home"&&<><div className="stats-grid"><Stat label="کل مأموریت‌ها" value={missions.length}/><Stat label="فعال" value={missions.filter(m=>!["delivered","failed","cancelled"].includes(m.status)).length}/><Stat label="تکمیل‌شده" value={missions.filter(m=>m.status==="delivered").length}/><Stat label="مانده حساب (تومان)" value={ledger.reduce((s,x)=>s+x.amount_toman,0)}/></div>
      <SectionTitle title="مأموریت‌های من" sub="برای مشاهده جزئیات، هر مأموریت را باز کنید" action={<><button className="small-button" onClick={load}><RefreshCw size={15}/> بروزرسانی</button><button className="primary-small" onClick={()=>setVisitOpen(true)}><Warehouse size={15}/> مراجعه به انبار</button></>}/>
      <div className="stack">{cashCollections.map(c=><div className="data-card" key={c.id}><div className="card-top"><strong>وجه نقد سفارش #{c.order_id.slice(0,8)}</strong><b>{money(c.amount_toman)}</b></div><button className="primary-small" onClick={()=>markCash(c)}>تأیید دریافت وجه</button></div>)}{missions.map(m=><MissionCard key={m.id} mission={m} items={items[m.id]||[]} onOpen={()=>setActiveMission(m.id)}/>)}
      {!missions.length&&<Empty text="در حال حاضر مأموریتی به شما ارجاع نشده است."/>}</div>
      {activeMission&&<MissionModal mission={missions.find(m=>m.id===activeMission)!} items={items[activeMission]||[]} checks={checksByOrder[missions.find(m=>m.id===activeMission)!.order_id]||[]} userId={profile.id} onClose={()=>setActiveMission(null)} onStatus={status} onUpdateItem={updateItem} onComplete={complete} onError={setError} onNotice={setNotice}/>}
      {visitOpen&&<WarehouseModal userId={profile.id} onClose={()=>setVisitOpen(false)} onDone={()=>{setVisitOpen(false);setNotice("مراجعه به انبار ثبت و به حساب شما اضافه شد.");load();}} onError={setError}/>}
    </>}
    {tab==="finance"&&<><SectionTitle title="حساب راننده" sub="گردش حساب و کرایه‌های ثبت‌شده"/><div className="balance-card"><span>مانده حساب</span><strong>{money(ledger.reduce((s,x)=>s+x.amount_toman,0))}</strong></div><div className="stack">{ledger.map(x=><div className="data-card compact" key={x.id}><div className="card-top"><strong>{ledgerLabel(x.entry_type)}</strong><b className={x.amount_toman<0?"negative":"positive"}>{money(x.amount_toman)}</b></div><p>{x.description||"—"}</p><small>{dateText(x.created_at)}</small></div>)}{!ledger.length&&<Empty text="تراکنشی ثبت نشده است."/>}</div></>}
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
  return <button className="mission-card" onClick={onOpen}><div className="card-top"><strong>مأموریت #{mission.id.slice(0,8)}</strong><Status value={mission.status}/></div><p>سفارش #{mission.order?.order_number?.toLocaleString("fa-IR")||"—"} · {mission.order?.freight_toman?money(mission.order.freight_toman):"کرایه ثبت نشده"}</p><div className="card-bottom"><small>{items.length.toLocaleString("fa-IR")} قلم کالا</small><ChevronLeft size={18}/></div></button>;
}
function MissionModal({mission,items,checks,userId,onClose,onStatus,onUpdateItem,onComplete,onError,onNotice}:{mission:Mission;items:MissionItem[];checks:CustomerCheck[];userId:string;onClose:()=>void;onStatus:(m:Mission,s:string,r?:string)=>void;onUpdateItem:(i:MissionItem,l:number,d:number,n:string)=>void;onComplete:(m:Mission,freightCollected:boolean)=>void;onError:(v:string)=>void;onNotice:(v:string)=>void}) {
  const [reason,setReason]=useState("");
  const [freightCollected,setFreightCollected]=useState(false);
  const [draft,setDraft]=useState<Record<string,{loaded:string;delivered:string;note:string}>>({});
  const [uploading,setUploading]=useState(false);
  async function uploadCheck(checkId:string,file:File){setUploading(true);try{const ext=file.name.split(".").pop()?.toLowerCase()||"jpg";const path=`${mission.id}/checks/${crypto.randomUUID()}.${ext}`;const up=await supabase.storage.from("mitra-private").upload(path,file,{contentType:file.type||"image/jpeg",upsert:false});if(up.error)throw up.error;const row=await supabase.from("check_photos").insert({check_id:checkId,storage_path:path,uploaded_by:userId});if(row.error)throw row.error;onNotice("تصویر چک با موفقیت بارگذاری شد.");}catch(e){onError(e instanceof Error?e.message:"بارگذاری تصویر چک ناموفق بود.");}finally{setUploading(false);}}
  async function uploadDelivery(file:File){setUploading(true);try{const ext=file.name.split(".").pop()?.toLowerCase()||"jpg";const path=`${mission.id}/delivery/${crypto.randomUUID()}.${ext}`;const up=await supabase.storage.from("mitra-private").upload(path,file,{contentType:file.type||"image/jpeg",upsert:false});if(up.error)throw up.error;const row=await supabase.from("delivery_proofs").insert({mission_id:mission.id,photo_path:path,uploaded_by:userId,customer_name:mission.customer?.full_name||null});if(row.error)throw row.error;onNotice("مدرک تحویل ثبت شد.");}catch(e){onError(e instanceof Error?e.message:"ثبت مدرک تحویل ناموفق بود.");}finally{setUploading(false);}}
  const canComplete=items.length>0&&items.every(i=>Number(draft[i.id]?.loaded??i.loaded_quantity??0)===i.ordered_quantity&&Number(draft[i.id]?.delivered??i.delivered_quantity??0)===i.ordered_quantity);
  const stages:Record<string,{label:string;next:string}>={
    assigned:{label:"پذیرش مأموریت",next:"accepted"},accepted:{label:"شروع بارگیری",next:"loading"},
    loading:{label:"حرکت به سمت مشتری",next:"on_the_way"}
  };
  return <Modal title="جزئیات مأموریت" onClose={onClose}><div className="form-stack">
    <div className="card-top"><strong>سفارش #{mission.order?.order_number?.toLocaleString("fa-IR")||"—"}</strong><Status value={mission.status}/></div>
    <div className="detail-box"><b>{mission.customer?.full_name||"اطلاعات مشتری"}</b><p>{mission.customer?.phone ? <>شماره تماس: <a href={`tel:${mission.customer.phone}`}>{mission.customer.phone}</a></> : "شماره تماس ثبت نشده است."}</p><p>{mission.customer?.address||"آدرس ثبت نشده است."}</p>
      {mission.customer?.latitude!=null&&mission.customer?.longitude!=null&&<p><a href={`https://nshn.ir/?lat=${mission.customer.latitude}&lng=${mission.customer.longitude}`} target="_blank" rel="noreferrer">مسیریابی در نشان</a></p>}
      <p>کرایه: {money(mission.order?.freight_toman)}</p><p>مانده نقدی: {money(mission.order?.customer_cash_balance_toman)}</p></div>
    <SectionTitle title="اقلام سفارش"/>
    {items.map(it=>{const v=draft[it.id]||{loaded:String(it.loaded_quantity??0),delivered:String(it.delivered_quantity??0),note:it.discrepancy_note||""};return <div className="item-edit" key={it.id}><b>{it.item?.mattress_name||"کالای سفارش"}</b><small>{[it.item?.brand,it.item?.size,weightFa[it.item?.weight||""]].filter(Boolean).join(" · ")}</small><span>تعداد سفارش: {it.ordered_quantity.toLocaleString("fa-IR")}</span><div className="inline-fields"><label>بارگیری<input type="number" min="0" max={it.ordered_quantity} value={v.loaded} onChange={e=>setDraft(d=>({...d,[it.id]:{...v,loaded:e.target.value}}))}/></label><label>تحویل<input type="number" min="0" max={it.ordered_quantity} value={v.delivered} onChange={e=>setDraft(d=>({...d,[it.id]:{...v,delivered:e.target.value}}))}/></label></div><label>توضیح مغایرت<input value={v.note} onChange={e=>setDraft(d=>({...d,[it.id]:{...v,note:e.target.value}}))}/></label><button className="small-button" onClick={()=>onUpdateItem(it,Number(v.loaded),Number(v.delivered),v.note)}>ثبت تعداد</button></div>;})}
    {checks.length>0&&<div className="detail-box"><b>تصاویر چک مشتری</b>{checks.map(c=><div key={c.id} className="item-edit"><span>{c.check_count.toLocaleString("fa-IR")} فقره · {money(c.total_amount_toman)} · {statusFa[c.status]||c.status}</span>{c.status==="awaiting_driver"&&<label>بارگذاری تصویر چک<input type="file" accept="image/*,.pdf" disabled={uploading} onChange={e=>{const f=e.target.files?.[0];if(f)uploadCheck(c.id,f);e.currentTarget.value="";}}/></label>}</div>)}</div>}
    {mission.status==="on_the_way"&&<div className="detail-box"><b>مدرک تحویل</b><label>بارگذاری عکس تحویل یا رسید<input type="file" accept="image/*,.pdf" disabled={uploading} onChange={e=>{const f=e.target.files?.[0];if(f)uploadDelivery(f);e.currentTarget.value="";}}/></label>{uploading&&<small>در حال بارگذاری…</small>}</div>}
    {stages[mission.status]&&<><button className="primary-button" disabled={mission.status==="loading"&&(items.length===0||!items.every(i=>Number(i.loaded_quantity||0)===i.ordered_quantity))} onClick={()=>onStatus(mission,stages[mission.status].next)}>{stages[mission.status].label}</button>{mission.status==="loading"&&(items.length===0||!items.every(i=>Number(i.loaded_quantity||0)===i.ordered_quantity))&&<small className="muted">برای حرکت به سمت مشتری، ابتدا تعداد بارگیری هر قلم را ثبت کنید و مطمئن شوید با تعداد سفارش برابر است.</small>}</>}
    {mission.status==="on_the_way"&&<><label className="check-line"><input type="checkbox" checked={freightCollected} onChange={e=>setFreightCollected(e.target.checked)}/> کرایه از مشتری دریافت شد</label><button className="primary-button" disabled={!canComplete} onClick={()=>onComplete(mission,freightCollected)}>ثبت اتمام مأموریت</button><small className="muted">برای اتمام، تعداد بارگیری و تحویل همه اقلام باید با تعداد سفارش برابر باشد. دریافت وجه نقد مشتری از بخش مربوط به وجه نقد در فهرست مأموریت‌ها تأیید می‌شود.</small></>}
    {["accepted","loading","on_the_way"].includes(mission.status)&&<div className="failure-box"><label>ثبت عدم انجام مأموریت / علت شکست<textarea value={reason} onChange={e=>setReason(e.target.value)} rows={2}/></label><button className="danger-button" disabled={!reason.trim()} onClick={()=>onStatus(mission,"failed",reason)}>ثبت مأموریت ناموفق</button></div>}
    <div className="modal-actions"><button className="secondary-button" onClick={onClose}>بستن</button></div>
  </div></Modal>;
}
function WarehouseModal({userId,onClose,onDone,onError}:{userId:string;onClose:()=>void;onDone:()=>void;onError:(v:string)=>void}) {
  const [name,setName]=useState("");const [address,setAddress]=useState("");const [freight,setFreight]=useState("");const [notes,setNotes]=useState("");const [receipt,setReceipt]=useState<File|null>(null);const [busy,setBusy]=useState(false);
  async function submit(e:FormEvent){e.preventDefault();setBusy(true);try{let receiptPath:string|null=null;if(receipt){const ext=receipt.name.split(".").pop()?.toLowerCase()||"jpg";receiptPath=`warehouse/${userId}/${crypto.randomUUID()}.${ext}`;const up=await supabase.storage.from("mitra-private").upload(receiptPath,receipt,{contentType:receipt.type||"image/jpeg",upsert:false});if(up.error)throw up.error;}const {error}=await supabase.rpc("driver_register_warehouse_visit",{p_request_id:crypto.randomUUID(),p_warehouse_name:name.trim(),p_freight_toman:Number(freight),p_address:address.trim()||null,p_notes:notes.trim()||null,p_receipt_photo_path:receiptPath});if(error)throw error;onDone();}catch(e){onError(e instanceof Error?e.message:"ثبت مراجعه ناموفق بود.");}finally{setBusy(false);}}
  return <Modal title="ثبت مراجعه به انبار شرکت دیگر" onClose={onClose}><form className="form-stack" onSubmit={submit}><Field label="نام انبار" value={name} set={setName} required/><Field label="آدرس" value={address} set={setAddress}/><Field label="کرایه (تومان)" value={freight} set={setFreight} type="number" required/><label>توضیحات<textarea rows={2} value={notes} onChange={e=>setNotes(e.target.value)}/></label><label>تصویر رسید (اختیاری)<input type="file" accept="image/*,.pdf" onChange={e=>setReceipt(e.target.files?.[0]||null)}/></label><p className="muted">پس از ثبت، مبلغ کرایه بلافاصله در دفتر حساب راننده منظور می‌شود.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>انصراف</button><button className="primary-button" disabled={busy}>{busy?"در حال ثبت…":"ثبت مراجعه"}</button></div></form></Modal>;
}
function ledgerLabel(t:string){return ({uncollected_freight:"کرایه دریافت‌نشده",warehouse_visit:"مراجعه به انبار",settlement:"تسویه حساب",adjustment:"اصلاح حساب"} as Record<string,string>)[t]||t;}
