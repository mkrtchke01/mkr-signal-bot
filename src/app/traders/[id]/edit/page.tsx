import { notFound } from "next/navigation";
import TraderForm from "@/components/TraderForm";
import { getTrader } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function EditTraderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trader = await getTrader(id);
  if (!trader) notFound();
  return <TraderForm initial={trader} />;
}
