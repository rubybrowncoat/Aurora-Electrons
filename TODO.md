User feedbacks:
- ~~The CMC label in Minerals.Body–perhaps you could visually differentiate between bodies that qualify for one and bodies that already have one.~~ Done: filled "CMC ×N" chip for existing complexes, outlined "CMC" chip for candidates.
- ~~The CMC tooltip the last part about changing the minerals is confusing. What does that mean?~~ Done: the minerals are fixed in the game's code, so the setting and that clause are gone; the tooltip states the game's rule.
- ~~Mining production is potentially being underreported. Significantly enough that I wonder if we are missing CMCs from it~~ Done: colonies that buy their CMCs' minerals and ship them by mass driver log no mining at all; Mineral Outlook now adds it from the formula.
- ~~In minerals the Potential tooltip is unclear and has caused confusion since potential was introduced.~~ Done: Potential is the average of a 0–10 score per mineral, with worked examples in the header tooltip and the per-mineral scores on each cell.

Follow-ups:
- ~~Taxed CMCs on a colony that also mines from orbit.~~ Not a gap: the game takes the complexes' share as their own output (`Population.ProcessMiningProduction`), so orbital output is never withheld and the ledger logs the full amount.
- ~~Colonization Planner's CMC site check.~~ Done: it now checks every founding condition in the game: CMCs switched on for the game, a shipyard, more than one settled colony, under 80 AU from the star at the farthest point of the orbit, not a gas giant, the star in reach (`Star.CheckNearbyLagrangePoints`), and no colony of any known race on the body (one of yours with only orbital miners doesn't block).
- ~~Minerals CMC chip on saves with CMCs switched off.~~ Done: candidate chips show only when `AllowCMC` is on and the body is within reach of its star.
- ~~Unlogged mass-driver mining at NPR and high-radiation colonies.~~ Done: an NPR always keeps its complexes' minerals, and at radiation 10,000 or more the complexes produce nothing, so both are left to the ledger.
