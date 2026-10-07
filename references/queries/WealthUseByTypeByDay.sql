SELECT
	--wd.*
	sum(wd.Amount) as DailyAmount
	,cast((c.GameTime - wd.TimeUsed)/86400 as int) as DaysAgo
	,wu.Description
FROM
	vw_const as c
inner JOIN FCT_WealthData as wd on wd.RaceID = c.RaceID
inner join DIM_WealthUse as wu on wu.WealthUseID = wd.UseID
group by 
	cast((c.GameTime - wd.TimeUsed)/86400 as int)
	,wu.Description
order by
	wu.Description
	,cast((c.GameTime - wd.TimeUsed)/86400 as int)