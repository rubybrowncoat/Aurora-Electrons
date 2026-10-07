--select min(GameTime) from FCT_CommanderHistory where GameID = 117

WITH 
param AS 
(
	SELECT
		2 as YearsToKeep
)

--select * from vw_const

/*
select count(*) from FCT_CommanderHistory
union ALL
select count(*) from FCT_CommanderHistory where GameID = 117
union ALL
select count(*) from FCT_CommanderHistory as ch inner join FCT_Commander as c on c.CommanderID = ch.CommanderID where RaceID = 607	--35909
*/
--select count(*) from FCT_CommanderHistory where ROWID in
--select count(*) from FCT_CommanderHistory where GameID = (select GameID from vw_const) and ROWID not in
select count(*) from FCT_CommanderHistory where ROWID not in
--delete from FCT_CommanderHistory where GameID = (select GameID from vw_const) and ROWID not in			-- to delete only records from this game
--delete from FCT_CommanderHistory where ROWID not in			-- to delete records from all games
(
	select ch.RowID --delete
	from FCT_CommanderHistory 	as ch
	inner join FCT_Commander	as cd		on cd.CommanderID = ch.CommanderID
	inner join vw_const			as c		on c.RaceID = cd.RaceID
	where 
		ch.GameTime >= c.GameTime - ((select YearsToKeep from param) * 365 * 24 * 60 * 60)	--for fleets of my race, keep history up to YearsToKeep years old
)
--order by GameTime


--select/delete all records for specific fleets
--select * --delete
--from FCT_FleetHistory where FleetID = (select FleetID from FCT_Fleet where FleetName = 'CS Luo Small C1 003')
	
/*
select 
	f.FleetID
	,f.FleetName
	,count(*) 
	,min(fh.GameTime)
from 
	FCT_FleetHistory as fh 
inner join 
	FCT_Fleet as f 
on 
	f.FleetID = fh.FleetID 
inner join 
	vw_const as c on c.RaceID = f.RaceID 
group by 
	f.FleetID,
	f.FleetName 
order by 4 asc
*/

	