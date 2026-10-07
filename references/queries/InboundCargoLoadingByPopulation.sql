--DROP VIEW IF EXISTS "main"."vw_InboundShippingTotalsByPopulation";
--CREATE VIEW vw_InboundShippingTotalsByPopulation as 

SELECT
	p.BasicPopName
	,case 
		when pi.Name is not null then pi.name
		when mo.MoveActionID = 136 then 'Infrastructure (TG)'
		else 'Pop(M)'
	end as Item
	,sum(case 
		when pi.Name is not null then cl.CargoCapacity/pi.CargoPoints/1.0
		when mo.MoveActionID = 136 then cl.CargoCapacity/2500.0
		else cl.ColonistCapacity / 1000.0 / 1000.0
	end ) as AmountLoading 
	--,mo.*
FROM
	vw_const as c
inner join	fct_fleet as f	on f.RaceID = c.RaceID
inner JOIN
	fct_ship as s
on
	s.FleetID = f.FleetID
inner JOIN FCT_ShipClass as cl on cl.ShipClassID = s.ShipClassID and (cl.CargoCapacity > 0 or cl.ColonistCapacity > 0)
/*
left JOIN
	FCT_ShipCargo as sc
on
	sc.ShipID = s.ShipID
*/
inner JOIN
	FCT_MoveOrders as mo
on
	mo.FleetID = f.FleetID
AND
(
	mo.MoveActionID = 4 -- load colonists
	or
	mo.MoveActionID = 176 -- Load Installation
	or
	(mo.MoveActionID = 136 and mo.DestinationItemType = 24 and	mo.DestinationItemID = 16) -- Load Trade Goods: Infrastructure
)
left JOIN
	DIM_PlanetaryInstallation as pi
on
	(mo.DestinationItemType = 2 and pi.PlanetaryInstallationID = mo.DestinationItemID)
--or	(mo.DestinationItemType = 24 and mo.DestinationItemID = 16 and pi.PlanetaryInstallationID = 9) -- join infra trade goods to infra pi
inner JOIN
	vw_popname as p
on
	p.PopulationID = mo.PopulationID
group by
	p.BasicPopName
	,case 
		when pi.Name is not null then pi.name
		when mo.MoveActionID = 136 then 'Infrastructure (TG)'
		else 'Pop(M)'
	end
order by
	p.BasicPopName
	,2
	

	
--	inner JOIN
--		FCT_Population as p
--	on
--		p.PopulationID = mo.PopulationID
--WHERE
	--f.CivilianFunction = 2
--AND
--	mo.MoveActionID in (6,96,177,137)