WITH 
const AS 
(
	SELECT 
		max(GameID) as GameID
		, max(RaceID) as RaceID
		, 2 as YearsToDelete
	from FCT_Race 
	where NPR=0
)
,CTE_GameTime as 
( 
	select 
		max(Time+0) as GameTime 
	from 
		FCT_GameLog as gl 
	inner join 
		const 
	on 
		gl.GameID = const.GameID 
)

--select * from const inner join CTE_GameTime on 1=1

--select * from FCT_Fleet as flt inner join const on const.RaceID = flt.RaceID order by FleetName
	

--delete old records
select fh.RowID --delete
from FCT_FleetHistory as fh
inner join const 				on const.GameID = fh.GameID
inner join FCT_Fleet as flt		on flt.FleetID = fh.FleetID
inner join CTE_GameTime as gt	on 1 = 1
where 
	 RaceID <> const.RaceID								--for fleets of other races, delete all history
or 
	GameTime <= 601045235.0 - 2 * 365 * 24 * 60 * 60	--for fleet of my race, delete history more than YearsToDelete years old
--order by GameTime


--select/delete all records for specific fleets
--select * 
--delete
from FCT_FleetHistory where FleetID = (select FleetID from FCT_Fleet where FleetName = 'YourFleetNameHere')
	
	

	