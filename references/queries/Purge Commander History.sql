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


--select * from const cross join CTE_GameTime

select count(*) from 
--delete from FCT_CommanderHistory where ROWID in
(
	select cdrh.ROWID 
	from FCT_CommanderHistory	as cdrh
	inner join const 						on const.GameID = cdrh.GameID
	cross join CTE_GameTime		as gt
	inner join FCT_Commander	as c		on c.CommanderID = cdrh.CommanderID
	where
		cdrh.GameTime <= gt.GameTime - const.YearsToDelete * 365 * 24 * 60 * 60
	or 
		c.RaceID <> const.RaceID
)
--order by GameTime

