-- /*
select 
	f.RaceID
	, rss.Name as System
	, f.FleetName
	, bn.BodyName
	,jp.JPName	
	,wp.Name as Waypoint
	, f.FleetID
	, f.CivilianFunction
	, f.Speed
	, sp.SpeciesName as ColonistSpecies, sc.Amount 
from fct_fleet as f 
left join FCT_RaceSysSurvey as rss on rss.RaceID = f.RaceID and rss.SystemID = f.SystemID
left join vw_BodyName as bn on bn.SystemBodyID = f.OrbitBodyID
left join fct_ship as s on s.FleetID = f.FleetID
left join FCT_ShipCargo as sc on sc.ShipID = s.ShipID
left join FCT_Species as sp on sp.SpeciesID = sc.SpeciesID
left JOIN
	vw_jumppoints as jp
on
	jp.Xcor = f.Xcor
AND
	jp.Ycor = f.Ycor
AND
	jp.SystemID = f.SystemID
left JOIN
	FCT_Waypoint as wp
on
	wp.Xcor = f.Xcor
AND
	wp.Ycor = f.Ycor
AND
	wp.SystemID = f.SystemID
AND
	wp.RaceID = f.RaceID

where f.ShippingLine > 0 
and f.GameID = (select GameID from vw_const)
--and f.RaceID = (select RaceID from vw_const)
and f.FleetID not in (select FleetID from FCT_MoveOrders) 
--and f.FleetID not in (select FleetID from FCT_Ship where ShipID in (select ShipID from FCT_ShipCargo))
order by 
--
--	f.FleetID,		-- order assignment probably goes by this order
	f.RaceID
	, f.CivilianFunction desc
	, sp.SpeciesName
	, sc.Amount
	, bn.BodyName
	, f.FleetName
-- */


-- to delete all idle civ fleets
-- 
/*
select f.* 
-- delete
from fct_fleet as f 
where f.ShippingLine > 0 
and f.GameID = (select GameID from vw_const)
and f.RaceID <> (select RaceID from vw_const)
and f.FleetID not in (select FleetID from FCT_MoveOrders) 
and f.FleetID not in (select FleetID from FCT_Ship where ShipID in (select ShipID from FCT_ShipCargo))
-- */

-- after deleting fleets, run all of these statements to remove the ships and other associated records
/*
delete from FCT_Ship where FleetID not in (select FleetID from FCT_Fleet);
delete from FCT_ShipCargo where ShipID not in (select ShipID from fct_ship);
delete from FCT_ShipHistory where ShipID not in (select ShipID from fct_ship);
delete from FCT_FleetHistory where FleetID not in (select FleetID from FCT_Fleet);
delete from FCT_Contacts where ContactType = 1 and ContactID not in (select ShipID from FCT_Ship);
update FCT_Commander set CommandID = 0, CommandType = 0 where CommandType = 1 and CommandID not in (select ShipID from FCT_Ship);
*/		-- end (do not include this line)




--select FleetID from FCT_Ship where ShipID in (select ShipID from FCT_ShipCargo)


--
/*

with cte_param as
(
	SELECT
		0 as IncludeAllRaces -- 1 to include results for all races, 0 for just your race
		,null as CivilianFunction	-- 1 = frt, 2 = col, 3 = harv, 4 = liner, 0= nonciv. null for all.
)

SELECT
	f.RaceID
	--, f.CivilianFunction
	, count(*) as fleets
	, sum(case when mo.FleetID is null and f.CivilianFunction = 0 then 1 else 0 end) as NonCiv_Idle
	, sum(case when mo.FleetID is null and f.CivilianFunction = 1 then 1 else 0 end) as FT_Idle
	, sum(case when mo.FleetID is null and f.CivilianFunction = 2 then 1 else 0 end) as CS_Idle
	--, sum(case when mo.FleetID is null and f.CivilianFunction = 3 then 1 else 0 end) as H_Idle
	, sum(case when mo.FleetID is null and f.CivilianFunction = 4 then 1 else 0 end) as SL_Idle
	, sum(case when mo.FleetID is null and f.CivilianFunction = 1 then cls.CargoCapacity/25000.0 else 0.0 end) as InstCap_Idle
	, sum(case when mo.FleetID is null and f.CivilianFunction = 1 and cls.CargoCapacity = 25000 then 1 else 0 end) as SF_Idle
	, sum(case when mo.FleetID is null and f.CivilianFunction = 1 and cls.CargoCapacity = 50000 then 1 else 0 end) as LFs_Idle
	, sum(case when mo.FleetID is null and f.CivilianFunction = 1 and cls.CargoCapacity = 125000 then 1 else 0 end) as HF_Idle
	, sum(case when mo.FleetID is null and f.CivilianFunction = 1 and cls.CargoCapacity not in (25000,50000,125000) then 1 else 0 end) as XF_Idle
	, sum(case when mo.FleetID is not null and f.CivilianFunction = 0 then 1 else 0 end) as NonCiv_Active
	, sum(case when mo.FleetID is not null and f.CivilianFunction = 1 then 1 else 0 end) as FT_Active
	, sum(case when mo.FleetID is not null and f.CivilianFunction = 2 then 1 else 0 end) as CS_Active
	--, sum(case when mo.FleetID is not null and f.CivilianFunction = 3 then 1 else 0 end) as H_Active
	, sum(case when mo.FleetID is not null and f.CivilianFunction = 4 then 1 else 0 end) as SL_Active
	, sum(case when mo.FleetID is not null and f.CivilianFunction = 1 then cls.CargoCapacity/25000.0 else 0.0 end) as InstCap_Active
	, sum(case when mo.FleetID is not null and f.CivilianFunction = 1 and cls.CargoCapacity = 25000 then 1 else 0 end) as SF_Active
	, sum(case when mo.FleetID is not null and f.CivilianFunction = 1 and cls.CargoCapacity = 50000 then 1 else 0 end) as LFs_Active
	, sum(case when mo.FleetID is not null and f.CivilianFunction = 1 and cls.CargoCapacity = 125000 then 1 else 0 end) as HF_Active
	, sum(case when mo.FleetID is not null and f.CivilianFunction = 1 and cls.CargoCapacity not in (25000,50000,125000) then 1 else 0 end) as XF_Active

FROM
	cte_param as p
cross join
	vw_const as c 
inner JOIN 
	fct_fleet as f
on 
	f.GameID = c.GameID
AND
	(p.IncludeAllRaces = 1 or f.RaceID = c.RaceID)
AND
	(p.CivilianFunction is null or f.CivilianFunction = p.CivilianFunction)
left JOIN
	FCT_MoveOrders as mo
on
	mo.FleetID = f.FleetID
left JOIN
	FCT_Population as p
on
	p.SystemBodyID = f.OrbitBodyID
or
	p.PopulationID = f.AssignedPopulationID
AND
	p.RaceID = c.RaceID
left join FCT_Ship as s on s.FleetID = f.FleetID
left join FCT_ShipClass as cls on cls.ShipClassID = s.ShipClassID
left join FCT_ShipCargo as sc on sc.ShipID = s.ShipID
--WHERE
--	f.ShippingLine > 0
--AND	
--	mo.FleetID is null
--AND
--	f.FleetName not like 'FH%' --ignore fuel harvesters


group by f.RaceID--, f.CivilianFunction
order by f.RaceID
--	f.FleetName,
	--f.RaceID, f.FleetID
--*/