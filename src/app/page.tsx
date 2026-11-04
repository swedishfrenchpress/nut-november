import Hero from "./components/Hero";
import About from "./components/About";
import Timeline from "./components/Timeline";
import Prizes from "./components/Prizes";
import HowToParticipate from "./components/HowToParticipate";
import Rules from "./components/Rules";
import FAQ from "./components/FAQ";
import Sponsors from "./components/Sponsors";
import Footer from "./components/Footer";

export default function Home() {
  return (
    <>
      <main id="main">
        <Hero />
        <About />
        <Timeline />
        <Prizes />
        <HowToParticipate />
        <Rules />
        <FAQ />
        <Sponsors />
      </main>
      <Footer />
    </>
  );
}
