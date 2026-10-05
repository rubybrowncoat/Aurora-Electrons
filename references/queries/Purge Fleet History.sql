WITH 
param AS 
(
	SELECT
		2 as YearsToKeep
)

--select * from vw_const

--select * from FCT_Fleet as flt inner join const on const.RaceID = flt.RaceID order by FleetName
--select count(*) from FCT_FleetHistory where GameID = 117
--select count(*) from FCT_FleetHistory as fh inner join vw_const as c on c.GameID = fh.GameID and fh.GameTime >= c.GameTime - (select YearsToKeep from param) * 365 * 24 * 60 * 60

/*
select count(*) from FCT_FleetHistory
union ALL
select count(*) from FCT_FleetHistory where GameID = 117
union ALL
select count(*) from FCT_FleetHistory as fh inner join FCT_Fleet as flt on flt.FleetID = fh.FleetID where RaceID = 607	--35580
*/
select count(*) from FCT_FleetHistory as fh where fh.ROWID not in
--select count(*) from FCT_FleetHistory as fh where fh.GameID = (select GameID from vw_const) AND fh.ROWID not in
--select count(*) from FCT_FleetHistory where ROWID not in
--delete from FCT_FleetHistory where ROWID not in
--delete from FCT_FleetHistory where GameID = (select GameID from vw_const) AND ROWID not in
(
	select fh.RowID --delete
	from FCT_FleetHistory 		as fh
	inner join FCT_Fleet		as flt		on flt.FleetID = fh.FleetID
	inner join vw_const			as c		on c.RaceID = flt.RaceID
	where 
		fh.GameTime >= c.GameTime - ((select YearsToKeep from param) * 365 * 24 * 60 * 60)	--for fleets of my race, keep history up to YearsToKeep years old
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
order by 3 desc
--order by 4 asc
*/

	