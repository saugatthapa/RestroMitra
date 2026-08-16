import { AdminRestaurantDetail } from "./AdminRestaurantDetail";

export default async function AdminRestaurantPage({
  params,
}: {
  params: Promise<{ restaurantId: string }>;
}) {
  const { restaurantId } = await params;
  return <AdminRestaurantDetail restaurantId={restaurantId} />;
}
