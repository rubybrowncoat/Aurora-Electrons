with cte_param as
(
	SELECT
		1 as IncludeAllRaces -- 1 to include results for all races, 0 for just your race
		,0 as CivShipsOnly
)


 --delete from FCT_ShipCargo where ShipID in (		--don't forget the closing parens at the end of the query


--	this is to make sure you didn't accidentally delete all shipcargo:
--	select * from FCT_ShipCargo where ShipID not in (		--don't forget the closing parens at the end of the query

SELECT
--	s.ShipID
--	distinct CargoTypeID, CargoID
--s.ShipID/*
	f.FleetName
	,f.RaceID
	,p.PopName
	,f.CivilianFunction
	,sc.*
	,f.*
	,*
--*/
FROM
	vw_const as c cross join cte_param as p
inner JOIN 
	fct_fleet as f 
on 
	f.GameID = c.GameID
AND
	(p.IncludeAllRaces = 1 or c.RaceID = f.RaceID)
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
inner join FCT_Ship as s on s.FleetID = f.FleetID
inner join FCT_ShipCargo as sc on sc.ShipID = s.ShipID
WHERE
	(p.CivShipsOnly = 0 or f.ShippingLine > 0)
AND
	f.CivilianFunction not in (2,4)		--exclude civ colonist ships and spaceliners (they load pop and then wait for orders)
AND
	mo.FleetID is null
AND
	f.FleetName not like 'FH%' --ignore fuel harvesters
AND
	f.FleetName not like '___ARK %' --ignore ark fleets
AND
	(f.FleetName not like '% Salvage %' or f.RaceID = c.RaceID) -- ignore NPR salvagers
order by
--	f.FleetName
	f.RaceID, f.FleetID
	
--)


-- select * from FCT_FleetHistory where FleetID = 474511
/*
 select 
	*
	, DATEtime('2050-01-01', '+' || cast(GameTime/60/60/24 as varchar) || ' DAY') as GameDate  
from FCT_FleetHistory 
where FleetID = (select FleetID from fct_ship where ShipID = 201566) 
order by GameTime desc
*/