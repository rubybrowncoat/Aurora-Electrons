--INSTRUCTIONS
--	Replace the RaceTitle values in CTE_Params with the full titles of the races in question
--	NOTE: these race titles must be unique across all games in your database
--	Replace the ship name values in CTE_ShipList with the names of the ships involved
--	To execute the script, first save and exit aurora, then run the script and commit changes, then reopen Aurora
-----------

drop table if exists temptblfuelxfers;
create temp table temptblfuelxfers as 
	with CTE_Params as
	(
		select
			(select RaceID from FCT_Race where RaceTitle = 'Empire of FuelSourceRace') as RaceIDSource 	-- the full title of the race unloading fuel
			,(select RaceID from FCT_Race where RaceTitle = 'Kingdom of FuelTargetRace') as RaceIDTarget	-- the full title of the race controlling earth
			,'Earth' as PopulationName
	)
	-- SELECT * from CTE_Params
	
	,CTE_ShipList as
	(
		SELECT
			'Tanker 005' as ShipName		-- replace values on these lines with the names of the ships you will be using. only ships in orbit of earth will be affected.
		union all select 'MiniTanker 001'
		union all select 'FastTanker 009'
		union all select 'anothershipname'	-- add more lines as needed
	)
	-- select * from CTE_ShipList

	,CTE_Population as
	(
		select 
			p.* 
		from CTE_Params as c
		inner join FCT_Population as p 
		on 
			p.RaceID = c.RaceIDTarget
		AND
			p.PopName = c.PopulationName
	)
	-- SELECT * from CTE_Population as cp

	,CTE_Ships as
	(
		SELECT
			s.*
			,sc.MinimumFuel
			,cp.PopulationID
		FROM
			CTE_Params as c
		inner JOIN FCT_Fleet as f 			on f.RaceID = c.RaceIDSource
		inner JOIN CTE_Population as cp 	on cp.SystemBodyID = f.OrbitBodyID
		inner JOIN FCT_Ship as s 			on s.FleetID = f.FleetID
		inner join CTE_ShipList as sl 		on sl.ShipName = s.ShipName
		inner join FCT_ShipClass as sc 		on sc.ShipClassID = s.ShipClassID
	)
	--SELECT * from CTE_Ships as cs

	select PopulationID,ShipID,Fuel,MinimumFuel from CTE_Ships
;
--select * from temptblfuelxfers
update FCT_Population as p set FuelStockpile = FuelStockpile + (select sum(Fuel - MinimumFuel) from temptblfuelxfers) where PopulationID = (select PopulationID from temptblfuelxfers limit 1);
update FCT_Ship as s set Fuel = t.MinimumFuel from temptblfuelxfers as t where s.ShipID = t.ShipID


	
