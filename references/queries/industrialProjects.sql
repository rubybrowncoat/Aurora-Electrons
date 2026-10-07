--query for current mineral consumption
--select * from vw_industrialProjects
--drop view vw_industrialProjects; 
--create view vw_industrialProjects as 

WITH const AS (SELECT
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as raceID
),

CTE_ProductionTypes as
(
				select 0 as ProductionType, 'installations' as ProductionTypeName	,'confac' as ProductionFacility
	union all 	select 1 as ProductionType, 'ordnance' as ProductionTypeName		,'ordfac' as ProductionFacility
	union all 	select 2 as ProductionType, 'fighter' as ProductionTypeName			,'ftrfac' as ProductionFacility
	union all 	select 3 as ProductionType, 'ship components' as ProductionTypeName	,'confac' as ProductionFacility
	union all 	select 4 as ProductionType, 'space station' as ProductionTypeName	,'confac' as ProductionFacility
),

CTE_PopulationProductionCapacity as 
(
	select
		p.PopulationID
		,sum(gsb.NetBonus_Production * pi.amount * r.ConstructionProduction * dpi.ConstructionValue) as ConstructionRate
		,sum(gsb.NetBonus_Production * pi.amount * r.FighterProduction * dpi.FighterProductionValue) as FighterProductionRate
		,sum(gsb.NetBonus_Production * pi.amount * r.OrdnanceProduction * dpi.OrdnanceProductionValue) as OrdnanceProductionRate		
	FROM
		const as c
	inner JOIN
		FCT_Race as r
	on
		r.RaceID = c.RaceID
	inner JOIN
		FCT_Population as p
	on
		p.RaceID = r.RaceID
	inner JOIN
		FCT_PopulationInstallations as pi
	on
		pi.PopID = p.PopulationID
	inner JOIN
		DIM_PlanetaryInstallation as dpi
	on
		dpi.PlanetaryInstallationID = pi.PlanetaryInstallationID
	inner JOIN
		vw_GovernorSectorBonus as gsb
	on
		gsb.PopulationID = p.PopulationID
	group by
		p.PopulationID
	
	--TODO: population efficiency modifiers (political, worker shortage, etc)
	
)


--surface production
SELECT
	vp.PopulationID
	,vp.PopName
	,vp.BasicPopName
	,ip.ProductionType --0=installations, 1=ordnance, 2=fighter, 3=???ship components???, 4=space station
	,cpt.ProductionFacility
	,IFNULL(cpt.ProductionTypeName,'UNKNOWN') as ProductionTypeName
	,ip.Description
	,ip.Percentage
	,365 * ip.BP / (ip.Percentage/100) / CASE
		when ip.ProductionType in (0,3,4) then ppc.ConstructionRate
		when ip.ProductionType in (1) then ppc.OrdnanceProductionRate
		when ip.ProductionType in (2) then ppc.FighterProductionRate
		else 0
	END as CompletionDays
	,ip.Queue
	,ip.BP
	,ip.Duranium
	,ip.Neutronium
	,ip.Corbomite
	,ip.Tritanium
	,ip.Boronide
	,ip.Mercassium
	,ip.Vendarite
	,ip.Sorium
	,ip.Uridium
	,ip.Corundium
	,ip.Gallicite
	--,ip.*
FROM
	const as c
/*
inner JOIN
	FCT_Race as r
on
	r.RaceID = c.RaceID
*/
inner JOIN
	FCT_Population as p
on
	p.RaceID =c.RaceID
left JOIN
	vw_popname as vp
on
	vp.PopulationID = p.PopulationID
inner JOIN
(
	SELECT
		ip.PopulationID
		,ip.ProductionType
		,ip.Description
		,ip.Percentage
		,ip.Queue
		,ip.Amount * ProdPerUnit as BP
		,ip.Amount * ip.Duranium as Duranium
		,ip.Amount * ip.Neutronium as Neutronium
		,ip.Amount * ip.Corbomite as Corbomite
		,ip.Amount * ip.Tritanium as Tritanium
		,ip.Amount * ip.Boronide as Boronide
		,ip.Amount * ip.Mercassium as Mercassium
		,ip.Amount * ip.Vendarite as Vendarite
		,ip.Amount * ip.Sorium as Sorium
		,ip.Amount * ip.Uridium as Uridium
		,ip.Amount * ip.Corundium as Corundium
		,ip.Amount * ip.Gallicite as Gallicite
	from
		FCT_IndustrialProjects as ip
	where ip.Pause = 0
) as ip
on
	ip.PopulationID = p.PopulationID
/*
inner JOIN
	FCT_PopulationInstallations as pi
on
	pi.PopulationID = p.PopulationID
AND
	pi.PlanetaryInstallationID = CASE
		when ip.ProductionType = 0 then 
*/
inner JOIN
	CTE_PopulationProductionCapacity as ppc
on
	ppc.PopulationID = p.PopulationID
left JOIN
	CTE_ProductionTypes as cpt
on
	cpt.ProductionType = ip.ProductionType
	
order by cpt.ProductionType desc

--ShipBuilding

--shiprepair

--shiprefit

--shipyard mods

--ground units