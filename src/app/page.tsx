import RiderApp from "@/components/RiderApp";
import { DEFAULT_AREA_ID } from "@/config/areas";

export default function Home() {
  return <RiderApp areaId={DEFAULT_AREA_ID} />;
}
