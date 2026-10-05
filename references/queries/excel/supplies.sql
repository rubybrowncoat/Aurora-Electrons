--drop view vw_supplies;
--create view vw_supplies as
select
	_pop.PopName as Pop
	,_pop.FuelStockpile / 1000000 as Fuel
	,case when pi_refuelpoint.PopID is null then 0 else 1 end as RefuelPoint
	,_pop.MaintenanceStockpile / 1000 as MSP
	,case when pi_resupplypoint.PopID is null then 0 else 1 end as ResupplyPoint
	,IFNULL(pi_mfcounts.MFCount,0) as MFCount
	,IFNULL(pop_MilTons.MilTons,0) as MilTons
	--,*
from
	FCT_Population as _pop
inner JOIN
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace
on
	CurrentRace.RaceID = _pop.RaceID
left JOIN
(
	select distinct pi.PopID from FCT_PopulationInstallations as pi
	left JOIN DIM_PlanetaryInstallation as dpi
	on dpi.PlanetaryInstallationID = pi.PlanetaryInstallationID
	where dpi.MassRefuelling = 1 and pi.Amount >= 1
) as pi_refuelpoint
on
	pi_refuelpoint.PopID = _pop.PopulationID
left JOIN
(
	select distinct pi.PopID from FCT_PopulationInstallations as pi
	left JOIN DIM_PlanetaryInstallation as dpi
	on dpi.PlanetaryInstallationID = pi.PlanetaryInstallationID
	where dpi.CargoShuttleValue > 0 or dpi.MaintenanceValue > 0
) as pi_resupplypoint
on
	pi_resupplypoint.PopID = _pop.PopulationID
left JOIN
(
	select pi.PopID, pi.Amount as MFCount from FCT_PopulationInstallations as pi
	left JOIN DIM_PlanetaryInstallation as dpi
	on dpi.PlanetaryInstallationID = pi.PlanetaryInstallationID
	where dpi.MaintenanceValue > 0	
) as pi_mfcounts
on
	pi_mfcounts.PopID = _pop.PopulationID
left JOIN
(
select
	flt.AssignedPopulationID as PopID
	,sum(ShipClass.Size)*50 as MilTons
FROM
	FCT_Fleet as flt
inner JOIN
	FCT_Ship as Ship
on
	Ship.FleetID = flt.FleetID
inner JOIN
	FCT_ShipClass as ShipClass
on
	ShipClass.ShipClassID = Ship.ShipClassID
WHERE
	ShipClass.Commercial = 0
AND
	Ship.MothershipID = 0 --ships docked in a hangar do not count towards planetary maintenance limits
group by
	flt.AssignedPopulationID
) as pop_MilTons
on
	pop_MilTons.PopID = _pop.PopulationID
where
	_pop.FuelStockpile > 0
or
	pi_refuelpoint.PopID is not null
or
	_pop.MaintenanceStockpile > 0
or
	pi_resupplypoint.PopID is not null
order by
	_pop.FuelStockpile desc
	,_pop.MaintenanceStockpile desc
	
	
	
--select * from FCT_Population as p where p.PopName like 'cat%'
--select * from FCT_PopulationInstallations where PopID = 4425